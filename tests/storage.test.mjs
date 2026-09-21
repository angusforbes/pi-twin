import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateDir } from '../src/storage.mjs';

test('durable state follows XDG_STATE_HOME and not the ephemeral runtime directory', t => {
  const base = mkdtempSync(join(tmpdir(), 'lc-state-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const a = stateDir({ XDG_STATE_HOME: base, XDG_RUNTIME_DIR: '/tmp/old-runtime' });
  const b = stateDir({ XDG_STATE_HOME: base, XDG_RUNTIME_DIR: '/tmp/new-runtime' });
  assert.equal(a, b); assert.equal(a, join(base, 'pi-live-clone')); assert.equal(statSync(a).mode & 0o777, 0o700);
});
test('state rejects symlink and non-private directory instead of changing access silently', t => {
  const base = mkdtempSync(join(tmpdir(), 'lc-state-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const open = join(base, 'open'); mkdirSync(open, { mode: 0o755 });
  assert.throws(() => stateDir({ PI_LIVE_CLONE_STATE_DIR: open }), /private/);
  const link = join(base, 'link'); symlinkSync(open, link);
  assert.throws(() => stateDir({ PI_LIVE_CLONE_STATE_DIR: link }), /symlink/);
  assert.throws(() => stateDir({ PI_LIVE_CLONE_STATE_DIR: '../relative' }), /absolute/);
});
