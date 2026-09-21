import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Controller } from '../src/controller.mjs';
import { mergeEnvelope } from '../src/model.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'live-controller-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sm = SessionManager.create(dir, join(dir, 'sessions'));
  sm.appendModelChange('anthropic', 'claude-sonnet-4-6'); sm.appendSessionInfo('Sift');
  sm.appendMessage({ role: 'user', content: 'A plan', timestamp: 1 });
  sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Ready' }], timestamp: 2 });
  let idle = true; const prompts = []; const launches = [];
  const ctx = { sessionManager: sm, cwd: dir, model: { provider: 'anthropic', id: 'claude-sonnet-4-6' }, isIdle: () => idle };
  const pi = { getSessionName: () => 'Sift', getThinkingLevel: () => 'high', sendMessage: (m, opts) => { assert.equal(idle, true); assert.equal(opts.triggerTurn, false); sm.appendCustomMessageEntry(m.customType, m.content, m.display, m.details); }, sendUserMessage: text => { prompts.push(text); idle = false; } };
  const launch = async c => { launches.push(c); return { paneId: 'w1:p2' }; };
  const controller = new Controller({ pi, ctx, dir, launch });
  return { controller, sm, ctx, pi, dir, launch, launches, prompts, setIdle: value => { idle = value; } };
}
async function handoff(f, id = 'request1', act = false) {
  const c = await f.controller.clone(id);
  return mergeEnvelope({ origin: c.lineage, sourceFile: c.file, text: 'Useful tangent', act });
}
test('clone does not change original session or invoke agent; duplicate request does not relaunch', async t => {
  const f = fixture(t); const original = readFileSync(f.sm.getSessionFile(), 'utf8');
  const one = await f.controller.clone('request1'); const two = await f.controller.clone('request1');
  assert.equal(one.childId, two.childId); assert.equal(f.launches.length, 1); assert.equal(f.prompts.length, 0);
  assert.equal(readFileSync(f.sm.getSessionFile(), 'utf8'), original);
});
test('busy clone freezes before first task and does not advance checkpoint during retries', async t => {
  const f = fixture(t); f.controller.beforeRun(f.ctx); f.setIdle(false);
  f.sm.appendMessage({ role: 'user', content: 'DO NOT COPY THIS', timestamp: 3 });
  f.controller.beforeRun(f.ctx);
  const c = await f.controller.clone('request1');
  assert.equal(c.lineage.busyCheckpoint, true); assert.ok(!readFileSync(c.file, 'utf8').includes('DO NOT COPY THIS'));
});
test('busy source without observed checkpoint refuses instead of guessing', async t => {
  const f = fixture(t); f.setIdle(false); await assert.rejects(f.controller.clone('request1'), /checkpoint unavailable/);
  assert.equal(f.launches.length, 0);
});
test('merge into busy original persists until settled and never interrupts it', async t => {
  const f = fixture(t); const m = await handoff(f); f.setIdle(false);
  assert.equal(f.controller.acceptMerge(m).status, 'queued'); assert.equal(f.controller.delivered(m.id), false); assert.equal(f.prompts.length, 0);
  f.setIdle(true); f.controller.settle(f.ctx);
  assert.equal(f.controller.receipt(m.id).status, 'delivered'); assert.equal(f.controller.delivered(m.id), true); assert.equal(f.prompts.length, 0);
});
test('duplicate imports are idempotent, different content under same ID rejected', async t => {
  const f = fixture(t); const m = await handoff(f); f.controller.acceptMerge(m); f.controller.acceptMerge(m);
  assert.equal(f.sm.getEntries().filter(e => e.type === 'custom_message' && e.details?.mergeId === m.id).length, 1);
  assert.throws(() => f.controller.acceptMerge({ ...m, text: 'changed' }), /different content/);
});
test('pending queue survives controller restart and still resolves to original session', async t => {
  const f = fixture(t); const m = await handoff(f); f.setIdle(false); f.controller.acceptMerge(m); f.controller.stop();
  const restored = new Controller({ pi: f.pi, ctx: f.ctx, dir: f.dir, launch: f.launch });
  assert.equal(restored.receipt(m.id).status, 'queued'); f.setIdle(true); restored.settle(f.ctx);
  assert.equal(restored.receipt(m.id).status, 'delivered');
});
test('action opt-in is delivered only after settle and triggers explicit user follow-up', async t => {
  const f = fixture(t); const m = await handoff(f, 'request1', true); f.setIdle(false); f.controller.acceptMerge(m);
  assert.equal(f.prompts.length, 0); f.setIdle(true); f.controller.settle(f.ctx);
  assert.equal(f.prompts.length, 1); assert.ok(f.prompts[0].includes(m.id));
});
test('wrong parent and unrecognized clone cannot inject context', async t => {
  const f = fixture(t); const m = await handoff(f);
  assert.throws(() => f.controller.acceptMerge({ ...m, parentId: 'wrong' }), /wrong original/);
  assert.throws(() => f.controller.acceptMerge({ ...m, childId: 'unknown' }), /Unknown clone/);
});
test('launch failure keeps recoverable clone and does not automatically retry', async t => {
  const f = fixture(t); let attempts = 0; f.controller.launch = async () => { attempts++; throw new Error('host timeout'); };
  await assert.rejects(f.controller.clone('request1'), /clone retained/);
  const again = await f.controller.clone('request1'); assert.equal(again.status, 'launch-unconfirmed'); assert.equal(attempts, 1);
});
test('stale controller refuses mutations after session teardown', async t => {
  const f = fixture(t); f.controller.stop(); await assert.rejects(f.controller.clone('request1'), /shut down/);
});
