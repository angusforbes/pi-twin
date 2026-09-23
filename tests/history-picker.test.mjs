import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, initTheme } from '@earendil-works/pi-coding-agent';
import { pickHistory } from '../src/history-picker.ts';
initTheme('dark', false);
for (const kind of ['tree', 'fork']) {
  for (const cancel of [false, true]) test(`native ${kind} picker ${cancel ? 'cancels' : 'selects'} without navigating`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'twin-picker-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage({ role: 'user', content: 'Choose this question', timestamp: 1 });
    const leaf = sm.getLeafId();
    const ctx = { mode: 'tui', sessionManager: sm, ui: { custom: factory => new Promise(resolve => {
      const component = factory({ terminal: { rows: 30 }, requestRender() {} }, {}, {}, resolve);
      assert.ok(component.render(80).length);
      component.handleInput(cancel ? '\x1b' : '\r');
    }) } };
    assert.equal(await pickHistory(ctx, kind), cancel ? undefined : leaf);
    assert.equal(sm.getLeafId(), leaf);
  });
}
test('history picker fails clearly outside the native TUI', async () => {
  await assert.rejects(pickHistory({ mode: 'rpc' }, 'tree'), /interactive terminal/);
});
