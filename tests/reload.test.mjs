import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { loadCore } from '../src/load-core.mjs';

test('reload refreshes controller dependencies despite an already-cached native ESM model', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'split-reload-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of ['controller.mjs', 'model.mjs', 'herdr.mjs', 'storage.mjs', 'ipc.mjs', 'wait.mjs']) {
    writeFileSync(join(dir, file), readFileSync(new URL('../src/' + file, import.meta.url)));
  }
  const path = join(dir, 'model.mjs');
  const current = readFileSync(path, 'utf8');
  writeFileSync(path, current.replace('`${root}[${letter}]`', '`${root}_old_${letter}`'));
  const native = await import(pathToFileURL(path).href);
  assert.equal(native.reserveName(join(dir, 'old-names'), 'parent', 'Thumper'), 'Thumper_old_a');
  const first = await loadCore(SessionManager, pathToFileURL(join(dir, 'loader.mjs')).href);
  assert.equal(first.model.reserveName(join(dir, 'first-names'), 'parent', 'Thumper'), 'Thumper_old_a');
  writeFileSync(path, current);
  const second = await loadCore(SessionManager, pathToFileURL(join(dir, 'loader.mjs')).href);
  const sm = SessionManager.create(dir, join(dir, 'sessions'));
  const controller = new second.controller.Controller({
    pi: { getSessionName: () => undefined, getThinkingLevel: () => 'high' },
    ctx: { sessionManager: sm, cwd: dir, model: { provider: 'test', id: 'model' }, isIdle: () => true },
    dir: join(dir, 'state'), resolveName: async () => '🟩 gpugenius', launch: async () => ({}),
  });
  const child = await controller.clone('new-request');
  assert.equal(child.name, 'gpugenius[a]');
  assert.equal(child.lineage.parentName, 'gpugenius');
});
