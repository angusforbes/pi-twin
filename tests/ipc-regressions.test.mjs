import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { startEndpoint, request, discover } from '../src/ipc.mjs';
async function dir(t) { const d = await mkdtemp(join(tmpdir(), 'lc-ipcr-')); t.after(() => rm(d, { recursive: true, force: true })); return d; }

test('an empty startup lock is never stolen while its creator may be writing PID', async t => {
  const d = await dir(t); const lock = join(d, createHash('sha256').update('session').digest('hex') + '.json.lock');
  await writeFile(lock, '', { mode: 0o600 });
  await assert.rejects(startEndpoint({ dir: d, sessionId: 'session', handle: () => ({}) }), e => e.code === 'EENDPOINT_EXISTS');
  assert.equal(await readFile(lock, 'utf8'), '');
});
test('explicit discovery refuses non-private directory', async t => {
  const d = await dir(t); await chmod(d, 0o755);
  await assert.rejects(discover({ dir: d }), /private/);
});
test('client rejects malformed response envelope without crashing the process', async t => {
  const d = await dir(t); const socket = join(d, 'malformed.sock');
  const server = net.createServer(s => { s.on('error', () => {}); s.once('data', () => s.end('null\n')); });
  await new Promise(resolve => server.listen(socket, resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(request({ socket, sessionId: 's', token: 't' }, { method: 'test' }), /envelope/);
});
test('round trip preserves multilingual payloads and emoji', async t => {
  const d = await dir(t); const ep = await startEndpoint({ dir: d, sessionId: 'unicode', handle: r => r.text }); t.after(() => ep.close());
  const text = '🌀 café 日本語 مرحبا'; assert.equal(await request(ep.descriptor, { text }), text);
});
