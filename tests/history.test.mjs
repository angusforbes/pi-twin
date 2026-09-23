import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { captureHistoricalSnapshot, createClone, mergeEnvelope, formatMerge, originOf } from '../src/model.mjs';
import { Controller } from '../src/controller.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'twin-history-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sm = SessionManager.create(dir, join(dir, 'sessions'));
  sm.appendSessionInfo('Thumper');
  const user = sm.appendMessage({ role: 'user', content: 'Earlier question', timestamp: 1 });
  const answer = sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }], timestamp: 2 });
  const later = sm.appendMessage({ role: 'user', content: 'Later question', timestamp: 3 });
  sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Later answer' }], timestamp: 4 });
  const pi = { getSessionName: () => 'Thumper', getThinkingLevel: () => 'high', sendMessage: m => sm.appendCustomMessageEntry(m.customType, m.content, m.display, m.details) };
  let busy = false;
  const ctx = { sessionManager: sm, cwd: dir, isIdle: () => !busy, model: { provider: 'test', id: 'current-model' } };
  const controller = new Controller({ pi, ctx, dir, launch: async () => ({}) });
  return { dir, sm, user, answer, later, controller, setBusy: value => { busy = value; } };
}
test('historical split selects an old path without changing a busy source or copying later turns', async t => {
  const f = fixture(t); const before = readFileSync(f.sm.getSessionFile(), 'utf8'), leaf = f.sm.getLeafId(); f.setBusy(true);
  const c = await f.controller.clone('history', { kind: 'tree', entryId: f.answer });
  const sm = SessionManager.open(c.file); const text = JSON.stringify(sm.buildSessionContext());
  assert.ok(text.includes('Earlier answer')); assert.ok(!text.includes('Later answer'));
  assert.equal(sm.buildSessionContext().model.modelId, 'current-model');
  assert.equal(originOf(sm).kind, 'tree'); assert.equal(originOf(sm).mergeAllowed, true);
  assert.equal(f.sm.getLeafId(), leaf); assert.equal(readFileSync(f.sm.getSessionFile(), 'utf8'), before);
});
test('permanent fork excludes selected prompt and retains its unsent draft', async t => {
  const f = fixture(t); const c = await f.controller.clone('fork', { kind: 'fork', entryId: f.later });
  const child = SessionManager.open(c.file), origin = originOf(child);
  assert.equal(origin.mergeAllowed, false); assert.equal(origin.history.draft, 'Later question');
  assert.ok(!JSON.stringify(child.buildSessionContext().messages).includes('Later question'));
  assert.throws(() => mergeEnvelope({ origin, sourceFile: c.file, text: 'Not allowed' }), /Permanent forks/);
  const forged = mergeEnvelope({ origin: { ...origin, mergeAllowed: true }, sourceFile: c.file, text: 'Not allowed' });
  assert.throws(() => f.controller.acceptMerge(forged), /Permanent forks/);
});
test('historical handoff is attributed into the parent current branch, not its past', async t => {
  const f = fixture(t); const c = await f.controller.clone('tree', { kind: 'tree', entryId: f.answer });
  const current = f.sm.getLeafId();
  const envelope = mergeEnvelope({ origin: c.lineage, sourceFile: c.file, text: 'A finding from earlier context' });
  assert.ok(formatMerge(envelope).includes('MESSAGE FROM EARLIER CONTEXT'));
  assert.equal(f.controller.acceptMerge(envelope).status, 'delivered');
  const imported = f.sm.getEntries().at(-1); assert.equal(imported.parentId, current);
  assert.ok(imported.content.includes('outdated assumptions'));
});
test('tree before-user and through-user have explicit different boundaries; attachments flagged', t => {
  const f = fixture(t);
  const id = f.sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Look here' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], timestamp: 5 });
  const before = captureHistoricalSnapshot(f.sm, id, { beforeUser: true });
  const through = captureHistoricalSnapshot(f.sm, id);
  assert.notEqual(before.entries.at(-1).id, id); assert.equal(through.entries.at(-1).id, id);
  assert.equal(before.history.draft, 'Look here'); assert.equal(before.history.omittedAttachments, true);
  assert.equal(through.history.draft, undefined);
  assert.throws(() => captureHistoricalSnapshot(f.sm, f.answer, { kind: 'fork' }), /user message/);
  assert.throws(() => captureHistoricalSnapshot(f.sm, 'missing'), /no longer available/);
});
test('historical selection can address an abandoned branch, not just current history', t => {
  const f = fixture(t); f.sm.branch(f.answer);
  f.sm.appendMessage({ role: 'user', content: 'Alternate path', timestamp: 9 });
  const snapshot = captureHistoricalSnapshot(f.sm, f.later);
  assert.equal(snapshot.entries.at(-1).id, f.later);
  assert.ok(!JSON.stringify(snapshot.entries).includes('Alternate path'));
});
test('historical interruptions preceding a later turn do not poison tree selections', async t => {
  const f = fixture(t);
  f.sm.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'lost-on-crash', name: 'bash', arguments: {} }], timestamp: 5 });
  const later = f.sm.appendMessage({ role: 'user', content: 'Continue after crash', timestamp: 6 });
  const answer = f.sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Continued safely' }], timestamp: 7 });
  for (const [id, selection] of [['through', { kind: 'tree', entryId: answer }], ['before', { kind: 'fork', entryId: later }]]) {
    const child = await f.controller.clone(id, selection);
    assert.equal(child.lineage.interruptedCalls, 1);
    const saved = SessionManager.open(child.file);
    assert.ok(JSON.stringify(saved.getEntries()).includes('Execution outcome is unknown'));
    assert.ok(!saved.getEntries().some(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolCallId === 'lost-on-crash'), 'no fabricated results in saved history');
  }
});
test('historical tool-call midpoint is refused, not silently shortened', async t => {
  const f = fixture(t);
  const midpoint = f.sm.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'bash', arguments: {} }], timestamp: 5 });
  f.sm.appendMessage({ role: 'toolResult', toolCallId: 'call', toolName: 'bash', content: [{ type: 'text', text: 'Complete now' }], timestamp: 6 });
  await assert.rejects(f.controller.clone('midpoint', { kind: 'tree', entryId: midpoint }), /incomplete tool batch/);
});
