import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { captureSnapshot, createClone, originOf, hasCloneActivity, bareName, reserveName, transcriptSince, mergeEnvelope, formatMerge, Mailbox } from '../src/model.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'live-clone-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sm = SessionManager.create('/tmp/example-project', dir);
  sm.appendModelChange('anthropic', 'claude-sonnet-4-6');
  sm.appendThinkingLevelChange('low');
  sm.appendSessionInfo('Sift');
  return { dir, sm };
}
function conversation(sm) {
  sm.appendMessage({ role: 'user', content: 'Discuss the project', timestamp: 1 });
  sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'We have a plan' }], api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-6', timestamp: 2, stopReason: 'stop', usage: {} });
}
function clone(snapshot, dir, extra = {}) {
  return createClone({ SessionManager, snapshot, sessionDir: dir, name: 'Sift[a]', model: { provider: 'anthropic', id: 'claude-opus-4-6' }, thinking: 'high', busy: false, ...extra });
}
test('native branch extraction preserves context and current settings without touching source', t => {
  const { dir, sm } = fixture(t); conversation(sm);
  const source = sm.getSessionFile(); const before = readFileSync(source, 'utf8'); const leaf = sm.getLeafId();
  const child = clone(captureSnapshot(sm), dir);
  const reopened = SessionManager.open(child.file);
  assert.notEqual(reopened.getSessionId(), sm.getSessionId());
  assert.equal(reopened.getHeader().parentSession, source);
  assert.equal(reopened.getCwd(), sm.getCwd());
  assert.equal(reopened.getSessionName(), 'Sift[a]');
  assert.equal(reopened.buildSessionContext().model.modelId, 'claude-opus-4-6');
  assert.equal(reopened.buildSessionContext().thinkingLevel, 'high');
  assert.ok(reopened.buildSessionContext().messages.some(m => m.role === 'user' && m.content === 'Discuss the project'));
  assert.equal(originOf(reopened).parentId, sm.getSessionId());
  assert.equal(sm.getLeafId(), leaf);
  assert.equal(readFileSync(source, 'utf8'), before);
  assert.equal(statSync(child.file).mode & 0o777, 0o600);
});
test('busy snapshot excludes initiating prompt and subsequent results even after source continues', t => {
  const { dir, sm } = fixture(t); conversation(sm);
  const snapshot = captureSnapshot(sm);
  sm.appendMessage({ role: 'user', content: 'Implement the plan NOW', timestamp: 3 });
  const child = clone(snapshot, dir, { busy: true });
  assert.ok(!readFileSync(child.file, 'utf8').includes('Implement the plan NOW'));
  assert.equal(SessionManager.open(child.file).getEntries().filter(e => e.type === 'message').length, 2);
  assert.equal(originOf(SessionManager.open(child.file)).busyCheckpoint, true);
});
test('first-prompt / metadata-only session is materialized and readable', t => {
  const { dir, sm } = fixture(t);
  assert.equal(existsSync(sm.getSessionFile()), false);
  const child = clone(captureSnapshot(sm), dir, { busy: true });
  const reopened = SessionManager.open(child.file);
  assert.equal(reopened.getSessionName(), 'Sift[a]');
  assert.equal(originOf(reopened).childId, child.childId);
  assert.equal(reopened.getEntries().some(e => e.type === 'message'), false);
});
test('empty path clone has no replayed task', t => {
  const { dir } = fixture(t); const sm = SessionManager.create('/tmp/example-project', dir);
  const child = clone(captureSnapshot(sm), dir);
  assert.equal(SessionManager.open(child.file).getEntries().filter(e => e.type === 'message').length, 0);
});
test('clone of clone records immediate parent and keeps only its own merge boundary', t => {
  const { dir, sm } = fixture(t); conversation(sm);
  const one = SessionManager.open(clone(captureSnapshot(sm), dir).file);
  one.appendMessage({ role: 'user', content: 'First tangent', timestamp: 3 });
  const two = SessionManager.open(clone(captureSnapshot(one), dir, { name: 'Sift[a][a]' }).file);
  assert.equal(originOf(two).parentId, one.getSessionId());
  assert.equal(originOf(two).name, 'Sift[a][a]');
  assert.ok(!transcriptSince(two, originOf(two)).includes('First tangent'));
});
test('native extraction preserves compaction context', t => {
  const { dir, sm } = fixture(t); conversation(sm);
  const user = sm.appendMessage({ role: 'user', content: 'Remember the blue widget', timestamp: 3 });
  sm.appendCompaction('Earlier plan summary', user, 1234);
  const child = SessionManager.open(clone(captureSnapshot(sm), dir).file);
  assert.ok(JSON.stringify(child.buildSessionContext()).includes('Earlier plan summary'));
  assert.ok(JSON.stringify(child.buildSessionContext()).includes('Remember the blue widget'));
});
test('transcript contains only divergent text, no thinking, and labels omitted images', t => {
  const { dir, sm } = fixture(t); conversation(sm);
  const child = SessionManager.open(clone(captureSnapshot(sm), dir).file);
  child.appendMessage({ role: 'assistant', content: [{ type: 'thinking', thinking: 'private chain' }, { type: 'text', text: 'Useful tangent' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], timestamp: 4 });
  const text = transcriptSince(child, originOf(child));
  assert.ok(text.includes('Useful tangent')); assert.ok(text.includes('Image attachment omitted'));
  assert.ok(!text.includes('private chain')); assert.ok(!text.includes('We have a plan'));
});
test('unused clone ignores inherited conversation, notice, and settings', t => {
  const { dir, sm } = fixture(t); conversation(sm);
  const child = SessionManager.open(clone(captureSnapshot(sm), dir).file);
  child.appendThinkingLevelChange('low'); child.appendSessionInfo('Renamed');
  assert.equal(hasCloneActivity(child, originOf(child)), false);
  const boundary = child.getLeafId();
  child.appendMessage({ role: 'user', content: 'New discussion', timestamp: 4 });
  assert.equal(hasCloneActivity(child, originOf(child)), true);
  child.branch(boundary);
  assert.equal(hasCloneActivity(child, originOf(child)), true, 'abandoned discussion must not auto-exit');
});
test('imported material and unknown boundary are not treated as unused', t => {
  const { dir, sm } = fixture(t);
  const child = SessionManager.open(clone(captureSnapshot(sm), dir).file);
  assert.equal(hasCloneActivity(child, { childId: 'missing' }), true);
  child.appendCustomMessageEntry('imported-context', 'Important handoff', true, {});
  assert.equal(hasCloneActivity(child, originOf(child)), true);
});
test('split names span a through z, remain reserved, and never wrap', t => {
  const { dir } = fixture(t);
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') assert.equal(reserveName(dir, 'parent', 'Thumper'), `Thumper[${letter}]`);
  assert.throws(() => reserveName(dir, 'parent', 'Thumper'), /All split names/);
  assert.equal(reserveName(dir, 'other-parent', 'Thumper[a]'), 'Thumper[a][a]');
});
test('names are deterministic exclusive reservations with decoration removed', t => {
  const { dir } = fixture(t);
  assert.equal(bareName('🌀 {#ffffff}Sift{}'), 'Sift');
  assert.equal(reserveName(dir, 'session1', 'Sift'), 'Sift[a]');
  assert.equal(reserveName(dir, 'session1', 'Sift'), 'Sift[b]');
  assert.throws(() => reserveName(dir, '../escape', 'Sift'));
});
test('merge envelope bounds data, explicitly attributes, and does not request action by default', () => {
  const origin = { childId: 'child', parentId: 'parent', name: 'Sift[a]', boundaryId: 'point' };
  const m = mergeEnvelope({ origin, sourceFile: '/saved/session', text: 'Interesting idea' });
  assert.equal(m.act, false); assert.ok(formatMerge(m).includes('Background context only'));
  assert.ok(formatMerge(m).includes('Sift[a]')); assert.throws(() => mergeEnvelope({ origin, text: 'x'.repeat(100000) }));
});
test('mailbox survives reopening and supports receipt updates', t => {
  const { dir } = fixture(t); const box = new Mailbox(join(dir, 'mail'));
  box.put({ id: 'merge-1', status: 'queued' });
  const restored = new Mailbox(join(dir, 'mail')); assert.equal(restored.get('merge-1').status, 'queued');
  restored.put({ id: 'merge-1', status: 'delivered' }); assert.equal(box.list().length, 1);
  assert.equal(box.get('merge-1').status, 'delivered'); assert.throws(() => box.get('../outside'));
});
