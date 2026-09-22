// Explicit opt-in: creates two disposable tabs on the CURRENT Herdr server,
// then closes only those tabs and restores the previously focused agent.
// No server restart, no real model request, no user/global Pi configuration edits.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { discover, runtimeDir, request } from '../src/ipc.mjs';
import { SessionManager } from '@earendil-works/pi-coding-agent';
if (!process.argv.includes('--run') || !process.env.HERDR_PANE_ID) throw new Error('Run explicitly with --run from inside Herdr; creates temporary tabs.');
const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), 'lc-herdr-'));
const ownedTabs = new Set(); let restorePane;
async function herdr(args) {
  const { stdout } = await exec('herdr', args, { timeout: 45000, maxBuffer: 1024 * 1024 });
  const r = JSON.parse(stdout); if (r.error) throw new Error(JSON.stringify(r.error)); return r.result;
}
try {
  const before = await herdr(['agent', 'list']); restorePane = before.agents.find(a => a.focused)?.pane_id;
  const env = { PI_CODING_AGENT_DIR: join(temp, 'config'), PI_CODING_AGENT_SESSION_DIR: join(temp, 'sessions'), PI_LIVE_CLONE_STATE_DIR: join(temp, 'state'), XDG_RUNTIME_DIR: join(temp, 'runtime'), PI_OFFLINE: '1', PI_TELEMETRY: '0' };
  for (const d of [env.PI_CODING_AGENT_DIR, env.PI_CODING_AGENT_SESSION_DIR, env.PI_LIVE_CLONE_STATE_DIR, env.XDG_RUNTIME_DIR, join(env.PI_CODING_AGENT_DIR, 'extensions')]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const provider = readFileSync(join(root, 'tests/fixtures/mock-provider.ts'), 'utf8').replace("if (!process.env.LIVE_CLONE_TEST_URL?.startsWith('http://127.0.0.1:')) throw new Error('Test provider requires loopback URL');", '').replace('process.env.LIVE_CLONE_TEST_URL', "'http://127.0.0.1:9/v1'");
  writeFileSync(join(env.PI_CODING_AGENT_DIR, 'extensions', 'test-provider.ts'), provider);
  const label = `LiveCloneTest_${Date.now()}`;
  const create = ['tab', 'create', '--workspace', process.env.HERDR_PANE_ID.split(':')[0], '--cwd', temp, '--label', label, '--no-focus'];
  for (const [k, v] of Object.entries(env)) create.push('--env', `${k}=${v}`);
  const tab = await herdr(create); ownedTabs.add(tab.tab.tab_id);
  await herdr(['agent', 'start', label.toLowerCase(), '--kind', 'pi', '--pane', tab.root_pane.pane_id, '--timeout', '30000', '--', '--provider', 'live-clone-test', '--model', 'mock', '--thinking', 'high', '--name', label, '-e', join(root, 'src/extension.ts')]);
  const dir = await runtimeDir({ ...process.env, ...env });
  // Herdr can detect an idle Pi screen before asynchronous session_start finishes.
  let original;
  for (let attempt = 0; attempt < 100 && !original; attempt++) {
    original = (await discover({ dir })).find(d => d.paneId === tab.root_pane.pane_id);
    if (!original) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!original) {
    const { stdout } = await exec('herdr', ['agent', 'read', tab.root_pane.pane_id, '--source', 'recent-unwrapped', '--lines', '60']);
    console.error(stdout);
  }
  assert.ok(original, 'real original endpoint started');
  const beforeState = await request(original, { method: 'status' });
  const child = await request(original, { method: 'clone', id: 'native-smoke-clone' }, { timeoutMs: 40000 });
  if (child.host?.tabId) ownedTabs.add(child.host.tabId);
  assert.equal(child.status, 'launched');
  assert.notEqual(child.host.paneId, tab.root_pane.pane_id);
  const clonePeer = (await discover({ dir })).find(d => d.sessionId === child.childId);
  assert.ok(clonePeer, 'real clone process started its endpoint');
  const cloneState = await request(clonePeer, { method: 'status' });
  assert.equal(cloneState.name, label + '[a]'); assert.equal(cloneState.idle, true);
  assert.equal((await request(original, { method: 'status' })).sessionId, beforeState.sessionId);
  const saved = SessionManager.open(child.file);
  assert.equal(saved.buildSessionContext().model.provider, 'live-clone-test'); assert.equal(saved.buildSessionContext().thinkingLevel, 'high');
  assert.equal(saved.getCwd(), temp);
  const info = await herdr(['agent', 'get', child.host.paneId]);
  assert.equal(cloneState.sessionId, child.childId);
  assert.equal(info.agent.tokens?.name, label + '[a]', JSON.stringify(info));
  assert.equal(info.agent.tokens?.live_clone_session, child.childId);
  console.log('PASS: actual Herdr creates two independent Pi tabs; original survives; clone named, idle, correct cwd/model/effort. No model calls. Native context-menu clicks not exercised.');
} finally {
  // Recover tabs even if a launch was uncertain; inspect only test-owned cwd.
  try {
    const agents = await herdr(['agent', 'list']);
    for (const a of agents.agents) if (a.cwd === temp || a.foreground_cwd === temp) ownedTabs.add(a.tab_id);
  } catch {}
  for (const id of ownedTabs) { try { await herdr(['tab', 'close', id]); } catch (e) { console.error(`Could not close test tab ${id}: ${e.message}`); } }
  if (restorePane) { try { await herdr(['agent', 'focus', restorePane]); } catch {} }
  rmSync(temp, { recursive: true, force: true });
}
