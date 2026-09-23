import test from 'node:test';
import assert from 'node:assert/strict';
import { createHerdr } from '../src/herdr.mjs';
function fixture(sessionId = 'this-session') {
  const calls = [];
  const host = createHerdr({ env: { HERDR_PANE_ID: 'w1:p2' }, run: async (_command, args) => {
    calls.push(args); return { stdout: JSON.stringify({ result: { agent: { tokens: { twin_session: sessionId } } } }) };
  } });
  return { host, calls };
}
test('confirmed twin close targets only its own pane, never its whole multi-pane tab', async () => {
  const { host, calls } = fixture();
  assert.equal(await host.closeSelf('this-session', () => true), true);
  assert.deepEqual(calls, [['agent', 'get', 'w1:p2'], ['pane', 'close', 'w1:p2']]);
});
test('wrong occupant or changed twin is never closed', async () => {
  const wrong = fixture('other-session');
  await assert.rejects(wrong.host.closeSelf('this-session', () => true), /identity/);
  assert.equal(wrong.calls.length, 1);
  const changed = fixture();
  await assert.rejects(changed.host.closeSelf('this-session', () => false), /changed/);
  assert.equal(changed.calls.length, 1);
});
test('without Herdr, caller can use graceful Pi shutdown', async () => {
  assert.equal(await createHerdr({ env: {} }).closeSelf('id', () => true), false);
});
