/**
 * Private Unix-socket IPC for pi-live-clone.
 *
 * Lets the Herdr out-of-band CLI communicate with a running Pi agent session
 * without terminal keystrokes. All communication is local, same-user only.
 *
 * Exports:
 *   runtimeDir(env?)       → Promise<string>
 *   startEndpoint(opts)    → Promise<{ descriptor, close() }>
 *   request(desc, payload) → Promise<result>
 *   discover(opts?)        → Promise<Descriptor[]>
 *
 * Security: private Unix sockets, 0700 dir, 0600 files, token+sessionId auth.
 * Guarantee is same-user-local only; not a sandbox against the same OS user.
 *
 * @module ipc
 */

import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// ─── protocol constants ───────────────────────────────────────────────────────

const MAX_REQUEST_BYTES  = 128 * 1024;   // 128 KiB per-connection read limit
const MAX_RESPONSE_BYTES = 1024 * 1024;  // 1 MiB response cap (server-side and client-side)
const CONNECTION_TIMEOUT_MS = 30_000;    // 30 s idle timeout per connection
/**
 * Conservative cross-platform Unix socket path limit.
 * Linux allows 108 bytes (incl. NUL); macOS/BSDs allow 104.
 * Checked via Buffer.byteLength to account for multi-byte path characters.
 */
const UNIX_PATH_MAX = 104;

// ─── internal helpers ─────────────────────────────────────────────────────────

/** @returns {number} */
function myUid() { return os.userInfo().uid; }

/**
 * SHA-256 hex digest of a UTF-8 string.
 * @param {string} s
 * @returns {string}
 */
function sha256hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Atomically write JSON to filePath with mode 0600.
 * Uses a sibling .tmp + rename so readers never see a partial write.
 * @param {string} filePath
 * @param {unknown} data
 */
async function writeAtomic600(filePath, data) {
  const tmp = `${filePath}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

/**
 * Test whether a Unix socket at socketPath is accepting connections right now.
 * Resolves within ~600 ms; never throws.
 * @param {string} socketPath
 * @returns {Promise<boolean>}
 */
function probeSocket(socketPath) {
  if (typeof socketPath !== 'string' || !socketPath) return Promise.resolve(false);
  return new Promise((resolve) => {
    const c = net.createConnection(socketPath);
    const t = setTimeout(() => { c.destroy(); resolve(true); }, 500);
    c.once('connect', () => { clearTimeout(t); c.destroy(); resolve(true); });
    c.once('error',   () => { clearTimeout(t); resolve(false); });
  });
}

/**
 * Create dirPath if absent, then validate: real directory (not symlink),
 * owned by current uid, mode 0700. Chmods only dirs we own.
 * @param {string} dirPath
 * @returns {Promise<string>} dirPath
 */
async function ensurePrivateDir(dirPath) {
  const uid = myUid();
  try { await fs.mkdir(dirPath, { mode: 0o700 }); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const st = await fs.lstat(dirPath);
  if (st.isSymbolicLink()) {
    throw Object.assign(new Error(`Dir must not be a symlink: ${dirPath}`), { code: 'ESYMLINK' });
  }
  if (!st.isDirectory()) {
    throw Object.assign(new Error(`Not a directory: ${dirPath}`), { code: 'ENOTDIR' });
  }
  if (st.uid !== uid) {
    throw Object.assign(new Error(`Dir not owned by uid ${uid}: ${dirPath}`), { code: 'EOWNER' });
  }
  if ((st.mode & 0o777) !== 0o700) await fs.chmod(dirPath, 0o700);
  return dirPath;
}

/**
 * Read-only directory validation (no mkdir, no chmod).
 * Returns the path when valid, null when dirPath does not exist.
 * Throws on symlink, not-a-directory, or wrong owner.
 * @param {string} dirPath
 * @returns {Promise<string|null>}
 */
async function validateDir(dirPath) {
  const uid = myUid();
  let st;
  try { st = await fs.lstat(dirPath); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  if (st.isSymbolicLink()) {
    throw Object.assign(new Error(`Dir must not be a symlink: ${dirPath}`), { code: 'ESYMLINK' });
  }
  if (!st.isDirectory()) {
    throw Object.assign(new Error(`Not a directory: ${dirPath}`), { code: 'ENOTDIR' });
  }
  if (st.uid !== uid) {
    throw Object.assign(new Error(`Dir not owned by uid ${uid}: ${dirPath}`), { code: 'EOWNER' });
  }
  if ((st.mode & 0o777) !== 0o700) throw new Error(`Dir must be private (0700): ${dirPath}`);
  return dirPath;
}

/**
 * Acquire an exclusive same-session startup lock via O_CREAT|O_EXCL,
 * run fn(), then unconditionally release the lock.
 *
 * Never steal a startup claim: an empty file may be a live owner between open
 * and write, and competing stale-lock removals can delete a newer claim.
 * Crash leftovers fail closed with an explicit manual-recovery instruction.
 *
 * @param {string}   lockPath
 * @param {string}   sessionId  Used in error messages only.
 * @param {Function} fn         Async body to run under the lock.
 * @returns {Promise<*>}
 */
async function withStartLock(lockPath, sessionId, fn) {
  let fh;
  try { fh = await fs.open(lockPath, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    throw Object.assign(new Error(`Startup claim already exists for session "${sessionId}". If a previous startup crashed, verify its process is gone before removing ${lockPath}.`), { code: 'EENDPOINT_EXISTS' });
  }
  try {
    await fh.writeFile(String(process.pid));
    return await fn();
  } finally {
    await fh.close();
    await fs.unlink(lockPath).catch(() => {});
  }
}

/**
 * Serialise a response envelope as a NL-terminated JSON line and half-close sock.
 * Output is capped at MAX_RESPONSE_BYTES; sends an error envelope if exceeded.
 * @param {net.Socket} sock
 * @param {{ ok: boolean, result?: unknown, error?: string }} envelope
 */
function sendResponse(sock, envelope) {
  try {
    const raw = JSON.stringify(envelope) + '\n';
    if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) {
      sock.end(JSON.stringify({ ok: false, error: 'Response exceeds 1 MiB limit' }) + '\n');
    } else {
      sock.end(raw);
    }
  } catch { sock.destroy(); }
}

/**
 * Parse, authorise, and dispatch one newline-terminated request line.
 * Operation whitelisting is the caller's responsibility inside `handle`.
 * @param {net.Socket} sock
 * @param {string} line
 * @param {{ token: string, sessionId: string, handle: Function }} opts
 */
async function dispatchRequest(sock, line, { token, sessionId, handle }) {
  let req;
  try { req = JSON.parse(line); } catch {
    sendResponse(sock, { ok: false, error: 'Malformed JSON in request' }); return;
  }
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    sendResponse(sock, { ok: false, error: 'Request must be a JSON object' }); return;
  }
  if (req.token !== token || req.sessionId !== sessionId) {
    sendResponse(sock, { ok: false, error: 'Unauthorized' }); return;
  }
  let result;
  try { result = await handle(req); } catch (e) {
    sendResponse(sock, { ok: false, error: String(e?.message ?? e) }); return;
  }
  sendResponse(sock, { ok: true, result });
}

/**
 * Wire up the per-connection protocol on an accepted socket.
 *
 * Reads one NL-terminated JSON line (BYTE limit: MAX_REQUEST_BYTES), dispatches,
 * closes. Uses StringDecoder to correctly handle UTF-8 sequences split across chunks.
 * Byte counting uses raw chunk.length (Buffer bytes), not string character count.
 *
 * @param {net.Socket} sock
 * @param {{ token: string, sessionId: string, handle: Function }} opts
 */
function handleConnection(sock, opts) {
  sock.setTimeout(CONNECTION_TIMEOUT_MS);
  sock.once('timeout', () => sock.destroy());
  sock.once('error', () => {}); // prevent unhandled-error crashes on destroyed sockets

  const decoder = new StringDecoder('utf8');
  let buf       = '';
  let byteCount = 0;  // raw bytes, not characters
  let consumed  = false;

  sock.on('data', (chunk) => {
    if (consumed) return;
    byteCount += chunk.length; // chunk is always a Buffer; .length is bytes
    if (byteCount > MAX_REQUEST_BYTES) {
      consumed = true;
      sendResponse(sock, { ok: false, error: 'Request exceeds 128 KiB limit' }); return;
    }
    buf += decoder.write(chunk); // handles split multi-byte sequences
    const nl = buf.indexOf('\n');
    if (nl === -1) return;
    consumed = true;
    dispatchRequest(sock, buf.slice(0, nl), opts);
  });
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Return (and create if needed) the private runtime directory for this user.
 *
 * Uses `$XDG_RUNTIME_DIR/pi-live-clone` when set, otherwise
 * `os.tmpdir()/pi-live-clone-<uid>`.
 *
 * Validates: real directory (not a symlink), owned by current uid, mode 0700.
 * Chmods only dirs we own.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string>} Absolute path to the validated private directory.
 */
export async function runtimeDir(env = process.env) {
  const uid  = myUid();
  const base = env.XDG_RUNTIME_DIR
    ? path.join(env.XDG_RUNTIME_DIR, 'pi-live-clone')
    : path.join(os.tmpdir(), `pi-live-clone-${uid}`);
  return ensurePrivateDir(base);
}

/**
 * Descriptor published to disk and returned from startEndpoint.
 *
 * @typedef {Object} Descriptor
 * @property {1}      version
 * @property {string} sessionId
 * @property {string} socket        - Absolute path to the Unix socket file.
 * @property {string} token         - Random 32-hex authorisation token.
 * @property {number} pid           - PID of the server process.
 * @property {string} [name]        - Optional session display name (from metadata).
 * @property {string} [paneId]      - Optional Herdr pane identifier (from metadata).
 * @property {string} [herdrSocket] - Optional Herdr control socket path (from metadata).
 * @property {string} [cwd]         - Optional working directory (from metadata).
 */

/**
 * Start a private IPC endpoint for one session.
 *
 * - Validates `dir` (or runtimeDir() if omitted) via ensurePrivateDir before
 *   any filesystem or socket operations.
 * - Acquires an exclusive per-session startup lock (O_CREAT|O_EXCL) that
 *   prevents concurrent startups for the same session without TOCTOU.
 * - Creates a randomly named Unix socket (chmod 0600) inside `dir`.
 *   Path byte length is checked via Buffer.byteLength against UNIX_PATH_MAX.
 * - Registers the connection handler BEFORE publishing the descriptor.
 * - Publishes an atomic 0600 descriptor at `dir/<sha256(sessionId)>.json`.
 * - Fails with EENDPOINT_EXISTS if an endpoint for the same session is live
 *   (either an existing startup claim or a live socket probe).
 * - Cleans a stale (dead-socket) descriptor before starting.
 * - Metadata keys matching security fields (version, sessionId, socket, token,
 *   pid) are silently dropped to prevent overrides.
 *
 * Protocol per connection: one NL-terminated JSON request (max 128 KiB) →
 * one NL-terminated JSON {ok, result|error} (max 1 MiB); 30 s idle timeout.
 * Authorization: request.token === token && request.sessionId === sessionId.
 * Operation whitelisting is the caller's responsibility inside `handle`.
 *
 * @param {object}   opts
 * @param {string}   opts.sessionId
 * @param {object}  [opts.metadata={}]   Merged into descriptor; security fields dropped.
 * @param {Function} opts.handle         async (request) => result
 * @param {string}  [opts.dir]           Override directory (default: runtimeDir()).
 * @returns {Promise<{ descriptor: Descriptor, close(): Promise<void> }>}
 */
export async function startEndpoint({ sessionId, metadata = {}, handle, dir } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new TypeError('sessionId must be a non-empty string');
  }
  if (typeof handle !== 'function') {
    throw new TypeError('handle must be a function');
  }

  // Validate dir (explicit or default) before any further filesystem work
  const resolvedDir = dir != null ? await ensurePrivateDir(dir) : await runtimeDir();

  const descPath   = path.join(resolvedDir, sha256hex(sessionId) + '.json');
  const lockPath   = descPath + '.lock';
  const socketName = 's-' + randomBytes(6).toString('hex') + '.sock';
  const socketPath = path.join(resolvedDir, socketName);

  // Use Buffer.byteLength for the path limit — multi-byte characters count extra
  if (Buffer.byteLength(socketPath) >= UNIX_PATH_MAX) {
    throw Object.assign(
      new Error(
        `Socket path too long (${Buffer.byteLength(socketPath)} bytes; limit ${UNIX_PATH_MAX} includes NUL): ${socketPath}`,
      ),
      { code: 'EPATH_TOO_LONG' },
    );
  }

  return withStartLock(lockPath, sessionId, async () => {
    // ── Inside the exclusive lock: check/clean stale descriptor ──────────────
    {
      let raw = null;
      try {
        const lst = await fs.lstat(descPath);
        if (lst.isSymbolicLink()) { await fs.unlink(descPath).catch(() => {}); }
        else { raw = await fs.readFile(descPath, 'utf8'); }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }

      if (raw !== null) {
        let existing = null;
        try { existing = JSON.parse(raw); } catch { /* corrupt — treat as stale */ }
        if (existing && await probeSocket(existing.socket)) {
          throw Object.assign(
            new Error(`Endpoint already live for session "${sessionId}"`),
            { code: 'EENDPOINT_EXISTS' },
          );
        }
        await fs.unlink(descPath).catch(() => {});
      }
    }

    // ── Start server ──────────────────────────────────────────────────────────
    const server      = net.createServer();
    const activeConns = new Set();

    await new Promise((resolve, reject) => {
      server.once('error', (e) => { server.close(); reject(e); });
      server.listen(socketPath, resolve);
    });

    try { await fs.chmod(socketPath, 0o600); } catch (e) {
      server.close(); await fs.unlink(socketPath).catch(() => {}); throw e;
    }

    // ── Build descriptor ──────────────────────────────────────────────────────
    const SECURITY_KEYS = new Set(['version', 'sessionId', 'socket', 'token', 'pid']);
    const safeMeta = Object.fromEntries(
      Object.entries(metadata).filter(([k]) => !SECURITY_KEYS.has(k)),
    );
    const token = randomBytes(16).toString('hex'); // 32 hex chars

    /** @type {Descriptor} */
    const descriptor = {
      version: 1, sessionId, socket: socketPath, token, pid: process.pid, ...safeMeta,
    };

    // ── Register connection handler BEFORE publishing descriptor ──────────────
    // Ensures no client that reads the descriptor can connect before we are ready.
    server.on('connection', (sock) => {
      activeConns.add(sock);
      sock.once('close', () => activeConns.delete(sock));
      handleConnection(sock, { token, sessionId, handle });
    });

    // ── Publish descriptor atomically ─────────────────────────────────────────
    try { await writeAtomic600(descPath, descriptor); } catch (e) {
      server.close(); await fs.unlink(socketPath).catch(() => {}); throw e;
    }

    let closed = false;

    /**
     * Idempotent shutdown: destroy active connections, close server,
     * remove socket file, and remove the descriptor only when it still
     * belongs to this endpoint (token + socket match).
     * @returns {Promise<void>}
     */
    async function close() {
      if (closed) return; closed = true;
      for (const c of activeConns) c.destroy();
      activeConns.clear();
      await new Promise((r) => server.close(r));
      await fs.unlink(socketPath).catch(() => {});
      try {
        const raw = await fs.readFile(descPath, 'utf8');
        const d   = JSON.parse(raw);
        if (d.token === token && d.socket === socketPath) await fs.unlink(descPath);
      } catch { /* already gone, replaced, or corrupt — leave it */ }
    }

    return { descriptor, close };
  });
}

/**
 * Send one request to a live endpoint and return the parsed result.
 *
 * Merges `token` and `sessionId` from `descriptor` into the outgoing payload,
 * overriding any same-named keys in `payload`.
 *
 * Response bytes are counted via raw chunk.length (not string length) and
 * capped at 1 MiB before any JSON parsing attempt.
 * Incoming chunks are decoded with StringDecoder to handle split UTF-8 sequences.
 *
 * **On timeout the outcome is uncertain.**  An Error with `timedOut: true` is
 * thrown.  Do NOT retry automatically.
 *
 * @param {Descriptor} descriptor
 * @param {object}     payload
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<unknown>}
 */
export async function request(descriptor, payload, { timeoutMs = 5000 } = {}) {
  if (typeof descriptor?.socket !== 'string') {
    throw new TypeError('descriptor.socket must be a string');
  }
  const { socket: socketPath, token, sessionId } = descriptor;
  const body = JSON.stringify({ ...payload, token, sessionId }) + '\n';

  return new Promise((resolve, reject) => {
    const sock    = net.createConnection(socketPath);
    const decoder = new StringDecoder('utf8');
    let settled   = false;
    let buf       = '';
    let rxBytes   = 0; // raw received bytes, not string characters

    function settle(fn, val) {
      if (settled) return; settled = true;
      clearTimeout(timer); sock.destroy(); fn(val);
    }

    const timer = setTimeout(() => {
      settle(reject, Object.assign(
        new Error('IPC request timed out — outcome is uncertain; do not retry automatically'),
        { timedOut: true },
      ));
    }, timeoutMs);

    sock.once('connect', () => sock.write(body));

    sock.on('data', (chunk) => {
      rxBytes += chunk.length; // chunk is a Buffer; .length is bytes
      if (rxBytes > MAX_RESPONSE_BYTES) {
        settle(reject, new Error('IPC response exceeded 1 MiB limit')); return;
      }
      buf += decoder.write(chunk); // handles multi-byte sequences split across chunks
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      let parsed;
      try { parsed = JSON.parse(buf.slice(0, nl)); } catch {
        settle(reject, new Error('Invalid JSON in IPC response')); return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.ok !== 'boolean') {
        settle(reject, new Error('Invalid IPC response envelope')); return;
      }
      if (parsed.ok) settle(resolve, parsed.result);
      else settle(reject, Object.assign(new Error(parsed.error ?? 'Request failed'), { ipcError: true }));
    });

    sock.once('error', (e) => settle(reject, e));
    sock.once('close', () => {
      if (!settled) settle(reject, new Error('IPC connection closed without response'));
    });
  });
}

/**
 * Return all valid descriptors found in the user's private runtime directory.
 *
 * Always validates `dir` (or runtimeDir() when omitted) before reading:
 * explicit dirs are checked for symlink / wrong owner (throws on violation;
 * returns [] when the path does not exist at all).
 *
 * Per-file validation: not a symlink, owned by current uid, mode exactly 0600,
 * minimal descriptor shape (version:1, sessionId, socket, token, pid strings/number).
 * Does not probe whether sockets are live; does no process scanning.
 *
 * @param {{ dir?: string }} [opts]
 * @returns {Promise<Descriptor[]>}
 */
export async function discover({ dir } = {}) {
  let resolvedDir;
  if (dir != null) {
    const valid = await validateDir(dir);
    if (valid === null) return []; // does not exist → no descriptors
    resolvedDir = valid;
  } else {
    resolvedDir = await runtimeDir();
  }

  const uid       = myUid();
  const HASH_JSON = /^[0-9a-f]{64}\.json$/;
  const results   = [];

  let entries;
  try { entries = await fs.readdir(resolvedDir); } catch { return []; }

  for (const entry of entries) {
    if (!HASH_JSON.test(entry)) continue;
    const filePath = path.join(resolvedDir, entry);
    try {
      const lst = await fs.lstat(filePath);
      if (lst.isSymbolicLink() || !lst.isFile()) continue;
      if (lst.uid !== uid) continue;
      if ((lst.mode & 0o777) !== 0o600) continue;

      const desc = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (
        typeof desc !== 'object' || desc === null || Array.isArray(desc) ||
        desc.version !== 1 ||
        typeof desc.sessionId !== 'string' || !desc.sessionId ||
        typeof desc.socket    !== 'string' || !desc.socket    ||
        typeof desc.token     !== 'string' || !desc.token     ||
        typeof desc.pid       !== 'number'
      ) continue;

      results.push(desc);
    } catch { /* skip unreadable / malformed */ }
  }
  return results;
}
