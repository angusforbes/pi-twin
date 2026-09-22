import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export const ORIGIN = 'pi-live-clone-origin-v1';
export const RECEIPT = 'pi-live-clone-receipt-v1';
export const MAX_MERGE_BYTES = 96 * 1024;

/** Capture only the active path, not abandoned branches or a partially streamed reply. */
export function captureSnapshot(sm) {
  const header = sm.getHeader();
  if (!header) throw new Error('Session has no header');
  return structuredClone({ header, entries: sm.getBranch(), sourceFile: sm.getSessionFile(), name: sm.getSessionName() });
}

export function originOf(sm) {
  const entries = sm.getBranch();
  // A clone of a clone retains ancestors' metadata. Only our own session's record applies.
  return entries.filter(e => e.type === 'custom' && e.customType === ORIGIN && e.data?.childId === sm.getSessionId()).at(-1)?.data;
}

/** Be conservative: activity on abandoned branches also prevents automatic exit. */
export function hasCloneActivity(sm, origin) {
  const entries = sm.getEntries();
  const start = entries.findIndex(e => e.type === 'custom' && e.customType === ORIGIN && e.data?.childId === origin.childId);
  if (start < 0) return true; // Unknown boundary is never proof of an unused clone.
  return entries.slice(start + 1).some(e => e.type === 'message' || e.type === 'compaction' || e.type === 'branch_summary' || (e.type === 'custom_message' && e.customType !== 'pi-live-clone-notice'));
}

export function bareName(name) {
  return String(name || 'Agent').replace(/\{#[0-9a-fA-F]{6}\}|\{\}/g, '').replace(/^[^\p{L}\p{N}_]+/u, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) || 'Agent';
}

/** Durable exclusive allocation: concurrent clicks cannot get the same clone name. */
export function reserveName(dir, sourceId, sourceName) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sourceId)) throw new Error('Invalid source session ID');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const root = bareName(sourceName);
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    const marker = join(dir, `${sourceId}-letter-${letter}.reserved`);
    const name = `${root}[${letter}]`;
    try {
      writeFileSync(marker, JSON.stringify({ sourceId, name }), { flag: 'wx', mode: 0o600 });
      return name;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('All split names [a] through [z] have been allocated for this parent. Names are not reused.');
}

/**
 * Use Pi's branch extraction on an independent snapshot manager, NEVER the source runtime.
 * The scratch source also covers first-prompt sessions Pi has not flushed to disk yet.
 * Finally materialize metadata-only sessions explicitly (Pi delays persistence until an
 * assistant reply). This manager is discarded after writing; the child reopens normally.
 */
export function createClone({ SessionManager, snapshot, sessionDir, name, model, thinking, busy }) {
  if (!model?.provider || !model?.id) throw new Error('Source has no active model');
  assertCompleteTools(snapshot.entries);
  if (!snapshot.sourceFile) throw new Error('Ephemeral sessions cannot be cloned persistently');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(sessionDir, '.live-clone-'));
  try {
    const snapFile = join(scratch, 'source.jsonl');
    writeFileSync(snapFile, [snapshot.header, ...snapshot.entries].map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
    const manager = SessionManager.open(snapFile, scratch);
    if (snapshot.entries.length) manager.createBranchedSession(snapshot.entries.at(-1).id);
    else manager.newSession({ parentSession: snapshot.sourceFile });
    const childId = manager.getSessionId();
    const lineage = {
      version: 1, childId, name, parentId: snapshot.header.id,
      parentFile: snapshot.sourceFile, parentName: bareName(snapshot.name),
      boundaryId: snapshot.entries.at(-1)?.id ?? null,
      createdAt: new Date().toISOString(), busyCheckpoint: !!busy,
    };
    manager.appendModelChange(model.provider, model.id);
    manager.appendThinkingLevelChange(thinking);
    manager.appendSessionInfo(name);
    manager.appendCustomEntry(ORIGIN, lineage);
    manager.appendCustomMessageEntry('pi-live-clone-notice',
      `You are ${name}, an independent live clone of ${lineage.parentName}. ` +
      (busy ? 'Your context stops before the prompt that started the original\'s current task. ' : '') +
      'The original remains active. Wait for your own user request; do not resume or repeat the original\'s task. ' +
      'You share the same working directory: changes to files affect both agents. This is not filesystem isolation.',
      true, { childId, parentId: lineage.parentId });
    const header = { ...manager.getHeader(), cwd: snapshot.header.cwd, parentSession: snapshot.sourceFile };
    const entries = manager.getEntries();
    const file = join(sessionDir, `${header.timestamp.replace(/[:.]/g, '-')}_${childId}.jsonl`);
    writeFileSync(file, [header, ...entries].map(e => JSON.stringify(e)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    return { file, childId, lineage, name };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export function assertCompleteTools(entries) {
  const pending = new Set();
  for (const e of entries) {
    if (e.type !== 'message') continue;
    const m = e.message;
    if (m.role === 'toolResult') {
      if (!pending.delete(m.toolCallId)) throw new Error('Snapshot contains an orphaned tool result; choose a completed conversation checkpoint');
      continue;
    }
    if (pending.size && (m.role === 'assistant' || m.role === 'user')) throw new Error('Snapshot contains an incomplete tool batch; finish or recover that task first');
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const call of m.content.filter(c => c.type === 'toolCall')) {
        if (pending.has(call.id)) throw new Error('Snapshot contains duplicate tool calls');
        pending.add(call.id);
      }
    }
  }
  if (pending.size) throw new Error('Snapshot contains an incomplete tool batch; finish or recover that task first');
}

/** Text rendering deliberately does not replay assistant/tool records or private thinking. */
export function transcriptSince(sm, origin) {
  const branch = sm.getBranch();
  const start = branch.findIndex(e => e.type === 'custom' && e.customType === ORIGIN && e.data?.childId === origin.childId);
  if (start < 0) throw new Error('Clone boundary is not on the active branch');
  const lines = [];
  for (const e of branch.slice(start + 1)) {
    if (e.type === 'compaction') lines.push(`[Compaction summary]\n${e.summary}`);
    if (e.type === 'branch_summary') lines.push(`[Branch summary]\n${e.summary}`);
    if (e.type === 'custom_message' && e.customType !== 'pi-live-clone-notice') {
      lines.push(`[Imported context: ${e.customType}]\n${textOf(e.content)}`);
    }
    if (e.type !== 'message') continue;
    const m = e.message;
    const text = textOf(m.content);
    const calls = Array.isArray(m.content) ? m.content.filter(c => c.type === 'toolCall').map(c => `[Tool call ${c.name}] ${JSON.stringify(c.arguments)}`).join('\n') : '';
    if (text || calls) lines.push(`[${m.role}${m.toolName ? ': ' + m.toolName : ''}]\n${[text, calls].filter(Boolean).join('\n')}`);
    if (Array.isArray(m.content) && m.content.some(c => c.type === 'image')) lines.push('[Image attachment omitted; retained in saved clone session.]');
  }
  return lines.join('\n\n') || '(No discussion since the split.)';
}
function textOf(content) { return typeof content === 'string' ? content : (content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'); }

export function mergeEnvelope({ origin, sourceFile, text, kind = 'summary', act = false, id = String(randomUUID()) }) {
  if (!text.trim()) throw new Error('Merge content is empty');
  if (Buffer.byteLength(text) > MAX_MERGE_BYTES) throw new Error('Merge exceeds 96 KiB; use a shorter summary. Full discussion stays in the saved session.');
  return { version: 1, id, childId: origin.childId, parentId: origin.parentId, name: origin.name, sourceFile, boundaryId: origin.boundaryId, kind, act: !!act, text, createdAt: new Date().toISOString() };
}

export function formatMerge(m) {
  return `Handoff from ${m.name} (${m.childId}).\nSource session: ${m.sourceFile}\nFork boundary: ${m.boundaryId ?? 'empty conversation'}\nMode: ${m.act ? 'User requests you consider and act on this handoff after your current task.' : 'Background context only; not a new instruction to execute tasks.'}\n\n` +
    'The following is attributed material from a separate conversation, not actions you performed. Shared files may have changed; recheck them before relying on either agent\'s account.\n\n' + m.text;
}

/** Small atomic durable mailbox. Caller serializes delivery; receipts in Pi history dedupe. */
export class Mailbox {
  constructor(dir) { this.dir = dir; mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  path(id) { if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid merge ID'); return join(this.dir, `${id}.json`); }
  get(id) { try { return JSON.parse(readFileSync(this.path(id), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } }
  put(record) {
    const path = this.path(record.id);
    const tmp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    try { renameSync(tmp, path); chmodSync(path, 0o600); } finally { rmSync(tmp, { force: true }); }
  }
  list() { return readdirSync(this.dir).filter(f => /^[a-zA-Z0-9_-]+\.json$/.test(f)).map(f => this.get(f.slice(0, -5))).filter(Boolean); }
}
