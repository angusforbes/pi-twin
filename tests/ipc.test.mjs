/**
 * Tests for src/ipc.mjs
 * Runner: node --test tests/ipc.test.mjs  (node:test, Node >= 22)
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

import { runtimeDir, startEndpoint, request, discover } from '../src/ipc.mjs';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Create a fresh 0700 temp dir for one test. */
async function mktemp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ipc-test-'));
}

/** Remove a tree silently. */
async function rm(p) {
  await fs.rm(p, { recursive: true, force: true }).catch(() => {});
}

/** Current process uid. */
function uid() { return os.userInfo().uid; }

/** Unique session id per test. */
function sessId() { return 'sess-' + randomBytes(6).toString('hex'); }

/** Descriptor filename for a session, mirrors module logic. */
function descFilename(sessionId) {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex') + '.json';
}

// ─── runtimeDir ───────────────────────────────────────────────────────────────

describe('runtimeDir', () => {

  test('creates pi-twin subdir under XDG_RUNTIME_DIR with mode 0700', async () => {
    const base = await mktemp();
    try {
      const dir = await runtimeDir({ XDG_RUNTIME_DIR: base });
      assert.equal(dir, path.join(base, 'pi-twin'));
      const st = await fs.stat(dir);
      assert.ok(st.isDirectory());
      assert.equal(st.mode & 0o777, 0o700);
      assert.equal(st.uid, uid());
    } finally { await rm(base); }
  });

  test('is idempotent: returns same path on repeated calls', async () => {
    const base = await mktemp();
    try {
      const a = await runtimeDir({ XDG_RUNTIME_DIR: base });
      const b = await runtimeDir({ XDG_RUNTIME_DIR: base });
      assert.equal(a, b);
    } finally { await rm(base); }
  });

  test('falls back to tmpdir/pi-twin-<uid> when XDG_RUNTIME_DIR absent', async () => {
    const dir = await runtimeDir({});
    try {
      assert.ok(dir.startsWith(os.tmpdir()));
      assert.ok(dir.endsWith(`pi-twin-${uid()}`));
      const st = await fs.stat(dir);
      assert.ok(st.isDirectory());
      assert.equal(st.mode & 0o777, 0o700);
    } finally { await rm(dir); }
  });

  test('repairs 0755 dir owned by us to 0700', async () => {
    const base = await mktemp();
    try {
      const cloneDir = path.join(base, 'pi-twin');
      await fs.mkdir(cloneDir, { mode: 0o755 });
      await runtimeDir({ XDG_RUNTIME_DIR: base });
      const st = await fs.stat(cloneDir);
      assert.equal(st.mode & 0o777, 0o700);
    } finally { await rm(base); }
  });

  test('rejects symlink at the runtime dir path (ESYMLINK)', async () => {
    const base = await mktemp();
    try {
      const real     = path.join(base, 'real');
      const linkPath = path.join(base, 'pi-twin');
      await fs.mkdir(real, { mode: 0o700 });
      await fs.symlink(real, linkPath);
      await assert.rejects(
        () => runtimeDir({ XDG_RUNTIME_DIR: base }),
        { code: 'ESYMLINK' },
      );
    } finally { await rm(base); }
  });

});

// ─── startEndpoint / request basics ──────────────────────────────────────────

describe('startEndpoint / request basics', () => {

  test('round-trip: handle result returned to caller', async () => {
    const dir = await mktemp();
    try {
      const { descriptor, close } = await startEndpoint({
        sessionId: sessId(),
        handle: async (req) => ({ echo: req.payload }),
        dir,
      });
      const result = await request(descriptor, { payload: 'hello' });
      assert.deepEqual(result, { echo: 'hello' });
      await close();
    } finally { await rm(dir); }
  });

  test('descriptor shape: version 1, sessionId, socket, 32-hex token, pid', async () => {
    const dir = await mktemp();
    const id  = sessId();
    try {
      const { descriptor, close } = await startEndpoint({
        sessionId: id, handle: async () => null, dir,
      });
      assert.equal(descriptor.version, 1);
      assert.equal(descriptor.sessionId, id);
      assert.ok(typeof descriptor.socket === 'string' && descriptor.socket.length > 0);
      assert.match(descriptor.token, /^[0-9a-f]{32}$/);
      assert.equal(descriptor.pid, process.pid);
      await close();
    } finally { await rm(dir); }
  });

  test('descriptor file at dir/<sha256(sessionId)>.json with mode 0600', async () => {
    const dir = await mktemp();
    const id  = sessId();
    try {
      const { descriptor, close } = await startEndpoint({
        sessionId: id, handle: async () => null, dir,
      });
      const expected = path.join(dir, descFilename(id));
      const st       = await fs.lstat(expected);
      assert.ok(st.isFile() && !st.isSymbolicLink());
      assert.equal(st.mode & 0o777, 0o600);
      const content = JSON.parse(await fs.readFile(expected, 'utf8'));
      assert.equal(content.token, descriptor.token);
      await close();
    } finally { await rm(dir); }
  });

  test('socket file has mode 0600', async () => {
    const dir = await mktemp();
    try {
      const { descriptor, close } = await startEndpoint({
        sessionId: sessId(), handle: async () => null, dir,
      });
      const st = await fs.lstat(descriptor.socket);
      assert.equal(st.mode & 0o777, 0o600);
      await close();
    } finally { await rm(dir); }
  });

  test('metadata fields merged into descriptor', async () => {
    const dir = await mktemp();
    try {
      const { descriptor, close } = await startEndpoint({
        sessionId: sessId(),
        metadata: { name: 'my-clone', paneId: 'p1', cwd: '/tmp', herdrSocket: '/tmp/h.sock' },
        handle: async () => null,
        dir,
      });
      assert.equal(descriptor.name, 'my-clone');
      assert.equal(descriptor.paneId, 'p1');
      assert.equal(descriptor.cwd, '/tmp');
      assert.equal(descriptor.herdrSocket, '/tmp/h.sock');
      await close();
    } finally { await rm(dir); }
  });

  test('metadata cannot override security fields', async () => {
    const dir   = await mktemp();
    const id    = sessId();
    const fakeT = 'f'.repeat(32);
    try {
      const { descriptor, close } = await startEndpoint({
        sessionId: id,
        metadata: { token: fakeT, version: 999, pid: 1, sessionId: 'injected', socket: '/evil' },
        handle: async () => null,
        dir,
      });
      assert.notEqual(descriptor.token,    fakeT);
      assert.equal(descriptor.version,     1);
      assert.equal(descriptor.pid,         process.pid);
      assert.equal(descriptor.sessionId,   id);
      assert.notEqual(descriptor.socket,   '/evil');
      await close();
    } finally { await rm(dir); }
  });

  test('handle throw is returned as {ok:false, error}', async () => {
    const dir = await mktemp();
    try {
      const { descriptor, close } = await startEndpoint({
        sessionId: sessId(),
        handle: async () => { throw new Error('handler blew up'); },
        dir,
      });
      await assert.rejects(() => request(descriptor, {}), /handler blew up/);
      await close();
    } finally { await rm(dir); }
  });

  test('startEndpoint throws TypeError for missing sessionId', async () => {
    await assert.rejects(() => startEndpoint({ handle: async () => {} }), TypeError);
  });

  test('startEndpoint throws TypeError for missing handle', async () => {
    await assert.rejects(() => startEndpoint({ sessionId: 'x' }), TypeError);
  });

  test('explicit dir is validated (symlink rejected with ESYMLINK)', async () => {
    const base = await mktemp();
    try {
      const real    = path.join(base, 'real');
      const symlink = path.join(base, 'link');
      await fs.mkdir(real, { mode: 0o700 });
      await fs.symlink(real, symlink);
      await assert.rejects(
        () => startEndpoint({ sessionId: sessId(), handle: async () => null, dir: symlink }),
        { code: 'ESYMLINK' },
      );
    } finally { await rm(base); }
  });

});

// ─── authorization ────────────────────────────────────────────────────────────

describe('authorization', () => {

  test('rejects request with wrong token', async () => {
    const dir = await mktemp();
    try {
      const { descriptor, close } = await startEndpoint({
        sessionId: sessId(), handle: async () => 'never', dir,
      });
      const bad = { ...descriptor, token: '0'.repeat(32) };
      await assert.rejects(() => request(bad, {}), /unauthorized/i);
      await close();
    } finally { await rm(dir); }
  });

  test('rejects request with wrong sessionId', async () => {
    const dir = await mktemp();
    try {
      const { descriptor, close } = await startEndpoint({
        sessionId: sessId(), handle: async () => 'never', dir,
      });
      const bad = { ...descriptor, sessionId: 'completely-wrong' };
      await assert.rejects(() => request(bad, {}), /unauthorized/i);
      await close();
    } finally { await rm(dir); }
  });

  test('cross-session credentials sent to wrong socket are rejected', async () => {
    const dir = await mktemp();
    try {
      const { descriptor: dA, close: cA } = await startEndpoint({
        sessionId: sessId(), handle: async () => 'A', dir,
      });
      const { descriptor: dB, close: cB } = await startEndpoint({
        sessionId: sessId(), handle: async () => 'B', dir,
      });
      // A's credentials sent to B's socket
      const cross = { socket: dB.socket, token: dA.token, sessionId: dA.sessionId };
      await assert.rejects(() => request(cross, {}), /unauthorized/i);
      await Promise.all([cA(), cB()]);
    } finally { await rm(dir); }
  });

});

// ─── oversized input ──────────────────────────────────────────────────────────

describe('oversized input', () => {

  test('server rejects request body > 128 KiB with {ok:false} response', async () => {
    const dir = await mktemp();
    try {
      const { descriptor, close } = await startEndpoint({
        sessionId: sessId(), handle: async () => 'never', dir,
      });

      // Send a raw oversized line directly, bypassing request()
      const response = await new Promise((resolve, reject) => {
        const sock = net.createConnection(descriptor.socket);
        let buf = '';
        sock.once('connect', () => sock.write('x'.repeat(130 * 1024) + '\n'));
        sock.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          if (buf.includes('\n')) {
            sock.destroy();
            try { resolve(JSON.parse(buf.slice(0, buf.indexOf('\n')))); }
            catch (e) { reject(e); }
          }
        });
        sock.once('error', reject);
        sock.once('close', () => { if (buf === '') reject(new Error('no data')); });
      });

      assert.equal(response.ok, false);
      assert.match(response.error, /128/);
      await close();
    } finally { await rm(dir); }
  });

  test('request() caps unbounded server response at 1 MiB', async () => {
    const dir = await mktemp();
    try {
      const sockName = 's-evil-' + randomBytes(4).toString('hex') + '.sock';
      const sockPath = path.join(dir, sockName);

      // Rogue server: ignores request, blasts 2 MiB then newline
      const evil = net.createServer((conn) => {
        conn.resume(); // drain incoming request bytes
        conn.write(Buffer.alloc(2 * 1024 * 1024, 0x41), () => conn.write('\n'));
        conn.once('error', () => {});
      });
      await new Promise((r) => evil.listen(sockPath, r));

      const fakeDesc = {
        version: 1, sessionId: 'evil-sess', socket: sockPath,
        token: '0'.repeat(32), pid: process.pid,
      };

      await assert.rejects(
        () => request(fakeDesc, {}, { timeoutMs: 5000 }),
        /1 MiB/i,
      );

      await new Promise((r) => evil.close(r));
    } finally { await rm(dir); }
  });

});

// ─── timeout ─────────────────────────────────────────────────────────────────

describe('timeout', () => {

  test('timedOut:true error with "uncertain" message; does not block', async () => {
    const dir = await mktemp();
    try {
      const { descriptor, close } = await startEndpoint({
        sessionId: sessId(),
        handle: () => new Promise(() => {}), // never resolves
        dir,
      });

      const t0 = Date.now();
      let err;
      try {
        await request(descriptor, { action: 'freeze' }, { timeoutMs: 150 });
        assert.fail('should have thrown');
      } catch (e) { err = e; }

      assert.ok(err.timedOut === true, 'timedOut flag must be true');
      assert.match(err.message, /uncertain/i);
      assert.ok(Date.now() - t0 < 2000, 'must resolve well under 2 s');
      await close();
    } finally { await rm(dir); }
  });

});

// ─── cleanup ─────────────────────────────────────────────────────────────────

describe('cleanup', () => {

  test('close() removes socket file and descriptor', async () => {
    const dir = await mktemp();
    const id  = sessId();
    try {
      const { descriptor, close } = await startEndpoint({
        sessionId: id, handle: async () => null, dir,
      });
      const descPath = path.join(dir, descFilename(id));
      await fs.access(descPath);              // exists while running
      await fs.access(descriptor.socket);
      await close();
      await assert.rejects(() => fs.access(descPath),          'descriptor must be removed');
      await assert.rejects(() => fs.access(descriptor.socket), 'socket must be removed');
    } finally { await rm(dir); }
  });

  test('close() is idempotent', async () => {
    const dir = await mktemp();
    try {
      const { close } = await startEndpoint({
        sessionId: sessId(), handle: async () => null, dir,
      });
      await close(); await close(); await close(); // must not throw
    } finally { await rm(dir); }
  });

  test('close() does not unlink descriptor belonging to a newer endpoint', async () => {
    const dir = await mktemp();
    const id  = sessId();
    try {
      const { close: close1 } = await startEndpoint({
        sessionId: id, handle: async () => null, dir,
      });
      await close1();

      const { descriptor: d2, close: close2 } = await startEndpoint({
        sessionId: id, handle: async () => 42, dir,
      });

      // Descriptor on disk must belong to d2
      const descPath = path.join(dir, descFilename(id));
      const ondisk   = JSON.parse(await fs.readFile(descPath, 'utf8'));
      assert.equal(ondisk.token, d2.token);

      assert.equal(await request(d2, {}), 42);
      await close2();
    } finally { await rm(dir); }
  });

});

// ─── endpoint collision ───────────────────────────────────────────────────────

describe('endpoint collision', () => {

  test('concurrent startEndpoint same session: exactly one succeeds (lock test)', async () => {
    const dir = await mktemp();
    const id  = sessId();
    try {
      const results = await Promise.allSettled([
        startEndpoint({ sessionId: id, handle: async () => null, dir }),
        startEndpoint({ sessionId: id, handle: async () => null, dir }),
      ]);

      const ok  = results.filter((r) => r.status === 'fulfilled');
      const err = results.filter((r) => r.status === 'rejected');

      assert.equal(ok.length,  1, 'exactly one should succeed');
      assert.equal(err.length, 1, 'exactly one should fail');
      assert.equal(err[0].reason.code, 'EENDPOINT_EXISTS');

      await ok[0].value.close();
    } finally { await rm(dir); }
  });

  test('sequential second start fails with EENDPOINT_EXISTS while first is live', async () => {
    const dir = await mktemp();
    const id  = sessId();
    try {
      const { close } = await startEndpoint({
        sessionId: id, handle: async () => null, dir,
      });
      try {
        await assert.rejects(
          () => startEndpoint({ sessionId: id, handle: async () => null, dir }),
          { code: 'EENDPOINT_EXISTS' },
        );
      } finally { await close(); }
    } finally { await rm(dir); }
  });

  test('cleans stale descriptor and starts successfully', async () => {
    const dir = await mktemp();
    const id  = sessId();
    try {
      // Plant a stale descriptor with a dead socket
      const descPath  = path.join(dir, descFilename(id));
      const staleDesc = {
        version: 1, sessionId: id,
        socket: path.join(dir, 's-dead-00000000.sock'), // does not exist
        token: 'a'.repeat(32), pid: 99999999,
      };
      await fs.writeFile(descPath, JSON.stringify(staleDesc), { mode: 0o600 });

      const { descriptor, close } = await startEndpoint({
        sessionId: id, handle: async () => 'restarted', dir,
      });
      assert.notEqual(descriptor.token, staleDesc.token);
      assert.equal(await request(descriptor, {}), 'restarted');
      await close();
    } finally { await rm(dir); }
  });

  test('symlink at descriptor path is removed and start succeeds', async () => {
    const dir = await mktemp();
    const id  = sessId();
    try {
      const descPath = path.join(dir, descFilename(id));
      const target   = descPath + '.target';
      await fs.writeFile(target, '{}', { mode: 0o600 });
      await fs.symlink(target, descPath);

      const { descriptor, close } = await startEndpoint({
        sessionId: id, handle: async () => 'ok', dir,
      });
      assert.equal(await request(descriptor, {}), 'ok');
      await close();
    } finally { await rm(dir); }
  });

});

// ─── separate sessions ────────────────────────────────────────────────────────

describe('separate sessions', () => {

  test('two endpoints coexist and route independently', async () => {
    const dir = await mktemp();
    try {
      const { descriptor: dA, close: cA } = await startEndpoint({
        sessionId: sessId(), handle: async () => 'from-A', dir,
      });
      const { descriptor: dB, close: cB } = await startEndpoint({
        sessionId: sessId(), handle: async () => 'from-B', dir,
      });
      const [rA, rB] = await Promise.all([request(dA, {}), request(dB, {})]);
      assert.equal(rA, 'from-A');
      assert.equal(rB, 'from-B');
      await Promise.all([cA(), cB()]);
    } finally { await rm(dir); }
  });

});

// ─── discover ─────────────────────────────────────────────────────────────────

describe('discover', () => {

  test('returns descriptor of a running endpoint', async () => {
    const dir = await mktemp();
    const id  = sessId();
    try {
      const { descriptor, close } = await startEndpoint({
        sessionId: id, handle: async () => null, dir,
      });
      const found = await discover({ dir });
      assert.equal(found.length, 1);
      assert.equal(found[0].sessionId, id);
      assert.equal(found[0].token,     descriptor.token);
      assert.equal(found[0].version,   1);
      assert.equal(typeof found[0].pid, 'number');
      await close();
      assert.equal((await discover({ dir })).length, 0);
    } finally { await rm(dir); }
  });

  test('returns multiple descriptors for multiple live sessions', async () => {
    const dir = await mktemp();
    try {
      const ids = [sessId(), sessId(), sessId()];
      const eps = await Promise.all(
        ids.map((id) => startEndpoint({ sessionId: id, handle: async () => null, dir })),
      );
      const found = await discover({ dir });
      assert.equal(found.length, 3);
      assert.deepEqual(found.map((d) => d.sessionId).sort(), [...ids].sort());
      await Promise.all(eps.map((ep) => ep.close()));
    } finally { await rm(dir); }
  });

  test('ignores symlink descriptor files', async () => {
    const dir = await mktemp();
    const id  = sessId();
    try {
      const { close } = await startEndpoint({
        sessionId: id, handle: async () => null, dir,
      });
      const descFile = path.join(dir, descFilename(id));
      const backup   = descFile + '.bak';
      await fs.copyFile(descFile, backup);
      await fs.unlink(descFile);
      await fs.symlink(backup, descFile);

      assert.equal((await discover({ dir })).length, 0, 'symlink descriptor must be rejected');

      await fs.unlink(descFile).catch(() => {});
      await close();
    } finally { await rm(dir); }
  });

  test('ignores descriptor files with permissions other than 0600', async () => {
    const dir = await mktemp();
    const id  = sessId();
    try {
      const { close } = await startEndpoint({
        sessionId: id, handle: async () => null, dir,
      });
      await fs.chmod(path.join(dir, descFilename(id)), 0o644);
      assert.equal((await discover({ dir })).length, 0, '0644 descriptor must be rejected');
      await close();
    } finally { await rm(dir); }
  });

  test('returns [] when directory does not exist', async () => {
    const missing = path.join(os.tmpdir(), 'ipc-no-such-' + randomBytes(8).toString('hex'));
    assert.deepEqual(await discover({ dir: missing }), []);
  });

  test('rejects explicit dir that is a symlink (ESYMLINK)', async () => {
    const base = await mktemp();
    try {
      const real    = path.join(base, 'real');
      const symlink = path.join(base, 'link');
      await fs.mkdir(real, { mode: 0o700 });
      await fs.symlink(real, symlink);
      await assert.rejects(() => discover({ dir: symlink }), { code: 'ESYMLINK' });
    } finally { await rm(base); }
  });

  test('ignores files with non-hash names', async () => {
    const dir = await mktemp();
    try {
      await fs.writeFile(path.join(dir, 'not-a-hash.json'), '{}', { mode: 0o600 });
      await fs.writeFile(path.join(dir, 'readme.txt'),      'hi', { mode: 0o600 });
      assert.deepEqual(await discover({ dir }), []);
    } finally { await rm(dir); }
  });

  test('ignores files with valid name but incomplete descriptor shape', async () => {
    const dir      = await mktemp();
    const fakeName = createHash('sha256').update('fake', 'utf8').digest('hex') + '.json';
    try {
      await fs.writeFile(
        path.join(dir, fakeName),
        JSON.stringify({ version: 1 }), // missing sessionId, socket, token, pid
        { mode: 0o600 },
      );
      assert.deepEqual(await discover({ dir }), []);
    } finally { await rm(dir); }
  });

});
