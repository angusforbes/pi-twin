import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runtimeDir, startEndpoint } from '../src/ipc.mjs';
const exec = promisify(execFile);
const cli = resolve('bin/pi-live-clone.mjs');
async function fixture(t, handle) {
  const temp = await mkdtemp(join(tmpdir(), 'lc-cli-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const env = { ...process.env, XDG_RUNTIME_DIR: temp, HERDR_SOCKET_PATH: '/test/herdr.sock' };
  const dir = await runtimeDir(env);
  const ep = await startEndpoint({ dir, sessionId: 'actual-session', metadata: { paneId: 'w1:p1', herdrSocket: env.HERDR_SOCKET_PATH }, handle });
  t.after(() => ep.close());
  return args => exec(process.execPath, [cli, ...args], { env, timeout: 5000 });
}
test('CLI pins pane actions to the expected Pi session', async t => {
  let calls = 0; const cli = await fixture(t, r => { calls++; return { method: r.method, status: 'launched' }; });
  await assert.rejects(cli(['clone', '--pane', 'w1:p1', '--expected-session', 'old-session']), e => e.stderr.includes('No live-clone endpoint'));
  assert.equal(calls, 0);
  const r = await cli(['clone', '--pane', 'w1:p1', '--expected-session', 'actual-session']);
  assert.equal(JSON.parse(r.stdout).status, 'launched'); assert.equal(calls, 1);
});
test('CLI does not label a retained in-progress record as successful launch', async t => {
  const cli = await fixture(t, () => ({ status: 'prepared', name: 'Sift_clone1' }));
  await assert.rejects(cli(['clone', '--pane', 'w1:p1', '--id', 'known-request']), e => e.code === 2 && e.stderr.includes('known-request'));
});
test('CLI reports request ID after an uncertain clone operation and never retries', async t => {
  let calls = 0; const cli = await fixture(t, () => { calls++; throw new Error('uncertain outcome'); });
  await assert.rejects(cli(['clone', '--pane', 'w1:p1', '--id', 'stable-id']), e => e.stderr.includes('stable-id'));
  assert.equal(calls, 1);
});
