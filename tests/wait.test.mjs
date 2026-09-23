import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForReceipt } from '../src/wait.mjs';

test('queued receipt waits and returns only after delivery', async () => {
  let reads = 0;
  const result = await waitForReceipt({ read: async () => ({ status: ++reads < 3 ? 'queued' : 'delivered' }), signal: new AbortController().signal, isCurrent: () => true, intervalMs: 1 });
  assert.equal(result.status, 'delivered'); assert.equal(reads, 3);
});
test('cancel during a receipt query never closes even if delivery succeeds', async () => {
  const abort = new AbortController();
  const result = await waitForReceipt({ read: async () => { abort.abort(); return { status: 'delivered' }; }, signal: abort.signal, isCurrent: () => true });
  assert.equal(result, undefined);
});
test('session replacement or new activity during a receipt query prevents closing', async () => {
  let current = true;
  const result = await waitForReceipt({ read: async () => { current = false; return { status: 'delivered' }; }, signal: new AbortController().signal, isCurrent: () => current });
  assert.equal(result, undefined);
});
test('unknown receipts and connection failures fail closed without resubmitting', async () => {
  for (const read of [async () => ({ status: 'unknown' }), async () => { throw new Error('Disconnected'); }]) {
    await assert.rejects(waitForReceipt({ read, signal: new AbortController().signal, isCurrent: () => true }));
  }
});
