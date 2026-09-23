import { setTimeout as delay } from 'node:timers/promises';

/** Poll receipts only: never resubmit a handoff or interrupt either agent. */
export async function waitForReceipt({ read, signal, isCurrent, intervalMs = 1500 }) {
  while (!signal.aborted && isCurrent()) {
    const receipt = await read();
    if (signal.aborted || !isCurrent()) return undefined;
    if (receipt.status === 'delivered') return receipt;
    if (receipt.status !== 'queued') throw new Error(`Handoff receipt is ${receipt.status}; twin kept open. Check /twin-merge-status before retrying.`);
    try { await delay(intervalMs, undefined, { signal }); }
    catch (error) { if (signal.aborted) return undefined; throw error; }
  }
  return undefined;
}
