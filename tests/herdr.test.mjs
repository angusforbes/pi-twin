import test from 'node:test';
import assert from 'node:assert/strict';
import { createHerdr, parseResponse } from '../src/herdr.mjs';

const child = { childId: '01234567-89ab-cdef-0123-456789abcdef', name: 'Sift[a]', cwd: '/tmp/project with spaces', file: '/tmp/conversation with spaces.jsonl', model: { provider: 'anthropic', id: 'claude-sonnet-4-6' }, thinking: 'high' };
test('Herdr launches an independent tab with native agent start and inherited settings', async () => {
  const calls = [];
  const host = createHerdr({ env: { HERDR_PANE_ID: 'w8:pS', HERDR_SOCKET_PATH: '/tmp/herdr.sock' }, extensionPath: '/tmp/extension.ts', run: async (cmd, args) => {
    calls.push([cmd, args]);
    return { stdout: JSON.stringify({ result: args[0] === 'tab' ? { tab: { tab_id: 'w8:tT' }, root_pane: { pane_id: 'w8:pT' } } : { success: true } }) };
  } });
  assert.deepEqual(await host.launch(child), { tabId: 'w8:tT', paneId: 'w8:pT' });
  assert.deepEqual(calls[0][1], ['tab', 'create', '--workspace', 'w8', '--cwd', child.cwd, '--label', child.name, '--focus']);
  assert.deepEqual(calls[1][1], ['agent', 'start', 'lc-0123456789abcdef01234567', '--kind', 'pi', '--pane', 'w8:pT', '--', '--session', child.file, '--provider', 'anthropic', '--model', 'claude-sonnet-4-6', '--thinking', 'high', '-e', '/tmp/extension.ts']);
  assert.equal(calls.some(([, args]) => args.includes('prompt') || args.includes('send-keys')), false);
});
test('non-Herdr host refuses automatic launch', async () => {
  await assert.rejects(createHerdr({ env: {} }).launch(child), /requires Herdr/);
});
test('publish uses explicit capability tokens and only renames own clone pane', async () => {
  const calls = []; const host = createHerdr({ env: { HERDR_PANE_ID: 'w8:pT' }, run: async (_cmd, args) => { calls.push(args); return { stdout: '{}' }; } });
  await host.publish({ name: 'Sift[a]', clone: true });
  assert.ok(calls[0].includes('live_clone=1')); assert.ok(calls[0].includes('live_clone_parent=1'));
  assert.ok(calls[0].includes('name=Sift[a]'));
  assert.equal(calls.length, 1);
  await host.publish({ enabled: false }); assert.ok(calls[1].includes('--clear-token'));
});
test('host errors are explicit, no shell fallback', () => {
  assert.throws(() => parseResponse('nonsense'), /non-JSON/);
  assert.throws(() => parseResponse('{"error":{"message":"not found"}}'), /not found/);
});

test('only safe configuration selectors propagate into a new tab, not credentials or source session IDs', async () => {
  const calls = [];
  const env = { HERDR_PANE_ID: 'w8:pS', PI_CODING_AGENT_DIR: '/tmp/private config', PI_LIVE_CLONE_STATE_DIR: '/tmp/state', OPENAI_API_KEY: 'must-not-appear', PI_SESSION_ID: 'original-id' };
  const host = createHerdr({ env, run: async (_cmd, args) => { calls.push(args); return { stdout: JSON.stringify({ result: { tab: { tab_id: 'w8:tT' }, root_pane: { pane_id: 'w8:pT' } } }) }; } });
  await host.launch(child);
  assert.ok(calls[0].includes('PI_CODING_AGENT_DIR=/tmp/private config'));
  assert.ok(calls[0].includes('PI_LIVE_CLONE_STATE_DIR=/tmp/state'));
  assert.ok(!JSON.stringify(calls).includes('must-not-appear'));
  assert.ok(!JSON.stringify(calls).includes('original-id'));
});
test('published capability contains the exact session ID for stale-menu protection', async () => {
  const calls = [];
  const host = createHerdr({ env: { HERDR_PANE_ID: 'w8:pS' }, run: async (_cmd, args) => { calls.push(args); return { stdout: '{}' }; } });
  await host.publish({ sessionId: 'pi-session-uuid', enabled: true });
  assert.ok(calls[0].includes('live_clone_session=pi-session-uuid'));
});
