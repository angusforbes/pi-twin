import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { DEFAULT_NAME_TEMPLATE } from './config.mjs';
import { captureSnapshot, captureHistoricalSnapshot, createClone, reserveName, originOf, Mailbox, MAX_MERGE_BYTES, formatMerge } from './model.mjs';

export function sessionKey(id) { return createHash('sha256').update(id).digest('hex'); }

/** No agent prompts, files, or lifecycle state are mutated by a clone request. */
export class Controller {
  constructor({ pi, ctx, dir, launch, resolveName = async () => undefined, nameTemplate = () => DEFAULT_NAME_TEMPLATE }) {
    this.pi = pi; this.ctx = ctx; this.dir = dir; this.launch = launch; this.resolveName = resolveName; this.nameTemplate = nameTemplate;
    this.sessionId = ctx.sessionManager.getSessionId();
    this.busySnapshot = undefined;
    this.active = true;
    this.merges = new Mailbox(join(dir, 'merges', sessionKey(this.sessionId)));
    this.clones = new Mailbox(join(dir, 'clones', sessionKey(this.sessionId)));
    this.outgoing = new Mailbox(join(dir, 'outgoing', sessionKey(this.sessionId)));
  }
  update(ctx) { this.ctx = ctx; }
  beforeRun(ctx) {
    this.update(ctx);
    // Retain the FIRST boundary across retries and queued continuations until full settle.
    this.busySnapshot ??= captureSnapshot(ctx.sessionManager);
  }
  settle(ctx) { this.update(ctx); this.busySnapshot = undefined; this.drain(); }
  stop() { this.active = false; }
  assertCurrent() {
    if (!this.active || this.ctx.sessionManager.getSessionId() !== this.sessionId) throw new Error('Source session was replaced or shut down');
  }
  status() {
    this.assertCurrent();
    return { sessionId: this.sessionId, name: this.pi.getSessionName(), idle: this.ctx.isIdle(), origin: originOf(this.ctx.sessionManager), pendingMerges: this.merges.list().filter(m => m.status !== 'delivered').map(m => m.id), clones: this.clones.list().map(c => ({ id: c.id, name: c.name, childId: c.childId, status: c.status, file: c.file, host: c.host })) };
  }
  async clone(requestId, selection) {
    this.assertCurrent();
    const old = this.clones.get(requestId);
    if (old) return old;
    const ctx = this.ctx;
    const busy = !selection && !ctx.isIdle();
    if (busy && !this.busySnapshot) throw new Error('Exact pre-task checkpoint unavailable. Wait for this task to settle; do not interrupt it.');
    const snapshot = selection ? captureHistoricalSnapshot(ctx.sessionManager, selection.entryId, selection) : structuredClone(busy ? this.busySnapshot : captureSnapshot(ctx.sessionManager));
    snapshot.name = this.pi.getSessionName() || snapshot.name;
    const model = ctx.model;
    const thinking = this.pi.getThinkingLevel();
    // Claim before the asynchronous display-name lookup to keep duplicate clicks idempotent.
    this.clones.put({ id: requestId, status: 'creating' });
    let child, name;
    try {
      if (!snapshot.name) snapshot.name = await this.resolveName();
      this.assertCurrent();
      name = reserveName(join(this.dir, 'names'), this.sessionId, snapshot.name, this.nameTemplate());
      child = createClone({ SessionManager, snapshot, sessionDir: dirname(snapshot.sourceFile), name, model, thinking, busy });
      const prepared = { id: requestId, status: 'prepared', ...child, model: { provider: model.provider, id: model.id }, thinking, cwd: ctx.cwd };
      this.clones.put(prepared);
      const launched = await this.launch(prepared);
      const record = { ...prepared, status: 'launched', host: launched };
      this.clones.put(record);
      return record;
    } catch (error) {
      const record = { id: requestId, status: child ? 'launch-unconfirmed' : 'failed', ...(child || {}), name, error: error.message };
      this.clones.put(record);
      throw new Error(`${error.message}${child ? `; clone retained at ${child.file}. Launch outcome may be uncertain; do not blindly retry.` : ''}`);
    }
  }
  acceptMerge(m) {
    this.assertCurrent();
    if (!m || m.version !== 1 || m.parentId !== this.sessionId || typeof m.childId !== 'string' || typeof m.name !== 'string' || typeof m.sourceFile !== 'string' || typeof m.text !== 'string' || !m.text.trim() || Buffer.byteLength(m.text) > MAX_MERGE_BYTES || !['summary', 'transcript'].includes(m.kind) || typeof m.act !== 'boolean') throw new Error('Invalid handoff or wrong original session');
    // Verify lineage from a retained clone record owned by this source, not caller claims.
    const record = this.clones.list().find(r => r.childId === m.childId && r.file === m.sourceFile);
    if (!record || record.lineage?.parentId !== this.sessionId) throw new Error('Unknown clone lineage');
    if (record.lineage.mergeAllowed === false) throw new Error('Permanent forks do not merge back');
    if (!!m.historical !== (record.lineage.kind === 'tree') || m.boundaryId !== record.lineage.boundaryId) throw new Error('Handoff history provenance does not match the saved split');
    const old = this.merges.get(m.id);
    if (old && JSON.stringify(old.envelope) !== JSON.stringify(m)) throw new Error('Merge ID already used for different content');
    if (!old) this.merges.put({ id: m.id, status: 'queued', envelope: m });
    this.drain();
    return this.merges.get(m.id);
  }
  delivered(id) {
    return this.ctx.sessionManager.getEntries().some(e => e.type === 'custom_message' && e.customType === 'pi-twin-merge' && e.details?.mergeId === id && e.details?.parentId === this.sessionId);
  }
  drain() {
    this.assertCurrent();
    if (!this.ctx.isIdle()) return;
    for (const record of this.merges.list()) {
      // Saved mailbox also repairs a crash after history append but before receipt update,
      // or a metadata-only Pi session that had not yet flushed its messages to disk.
      if (this.delivered(record.id)) {
        if (record.status !== 'delivered') this.merges.put({ ...record, status: 'delivered' });
        continue;
      }
      const m = record.envelope;
      this.pi.sendMessage({ customType: 'pi-twin-merge', content: formatMerge(m), display: true, details: { mergeId: m.id, childId: m.childId, parentId: this.sessionId } }, { triggerTurn: false });
      if (!this.delivered(m.id)) throw new Error('Pi has not confirmed the handoff append; retained in durable queue');
      this.merges.put({ ...record, status: 'delivered', deliveredAt: new Date().toISOString() });
      if (m.act) {
        this.pi.sendUserMessage(`Please consider the imported handoff from ${m.name} (merge ${m.id}) and act on the requested follow-up.`, { deliverAs: 'followUp' });
        // Do not append another handoff while this request is starting.
        break;
      }
    }
  }
  receipt(id) { this.assertCurrent(); return this.merges.get(id) ?? { id, status: 'unknown' }; }
}
