import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNameTemplate, validateNameTemplate } from '../src/config.mjs';
import { reserveName } from '../src/model.mjs';
function fixture(t) { const dir = mkdtempSync(join(tmpdir(), 'twin-config-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
test('missing config uses default, changes are read on each split', t => {
  const dir = fixture(t), env = { PI_CODING_AGENT_DIR: dir };
  assert.equal(readNameTemplate(env), '{parent}[{letter}]');
  writeFileSync(join(dir, 'pi-twin.json'), JSON.stringify({ nameTemplate: '{parent}-{number}' }));
  assert.equal(readNameTemplate(env), '{parent}-{number}');
  writeFileSync(join(dir, 'pi-twin.json'), JSON.stringify({ nameTemplate: '{parent}-twin-{letter}' }));
  assert.equal(readNameTemplate(env), '{parent}-twin-{letter}');
});
test('invalid configuration fails visibly rather than silently changing naming', t => {
  const dir = fixture(t);
  for (const text of ['{', 'null', '[]', '{"unknown":1}', '{"nameTemplate":"same"}']) {
    writeFileSync(join(dir, 'pi-twin.json'), text);
    assert.throws(() => readNameTemplate({ PI_CODING_AGENT_DIR: dir }));
  }
  for (const template of ['{parent}', '{number}', '{parent}-{typo}', '{parent}\n{number}', 'x'.repeat(201)]) assert.throws(() => validateNameTemplate(template));
});
test('changing format preserves allocated indices and numeric names extend beyond z', t => {
  const dir = fixture(t);
  assert.equal(reserveName(dir, 'source', 'Thumper'), 'Thumper[a]');
  assert.equal(reserveName(dir, 'source', 'Thumper', '{parent}-{number}'), 'Thumper-2');
  assert.equal(reserveName(dir, 'source', 'Thumper', '{parent}-twin-{letter}'), 'Thumper-twin-c');
  for (let n = 4; n <= 27; n++) assert.equal(reserveName(dir, 'source', 'Thumper', '{parent}-{number}'), `Thumper-${n}`);
});
