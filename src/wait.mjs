import { setTimeout as delay } from 'node:timers/promises';

/** Poll receipts only: never resubmit a handoff or interrupt either agent. */
export async function waitForReceipt({ read, signal, isCurrent, intervalMs = 1500 }) {
  while (!signal.aborted && isCurrent()) {
    // Receipt queries are read-only and bounded, but cancellation must release
    // the UI immediately rather than waiting for a disconnected peer's timeout.
    let onAbort;
    const cancelled = new Promise(resolve => {
      onAbort = () => resolve(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    let receipt;
    try { receipt = await Promise.race([Promise.resolve().then(() => signal.aborted ? undefined : read()), cancelled]); }
    finally { signal.removeEventListener('abort', onAbort); }
    if (signal.aborted || !isCurrent()) return undefined;
    if (receipt.status === 'delivered') return receipt;
    if (receipt.status !== 'queued') throw new Error(`Handoff receipt is ${receipt.status}; twin kept open. Check /twin-merge-status before retrying.`);
    try { await delay(intervalMs, undefined, { signal }); }
    catch (error) { if (signal.aborted) return undefined; throw error; }
  }
  return undefined;
}
