// Real Pi processes + real extension IPC; local mock model and mocked Herdr CLI.
// No paid provider calls, real desktop panes, global config changes, or server restart.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover, runtimeDir, request } from '../src/ipc.mjs';
import { mergeEnvelope } from '../src/model.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), 'lc-rpc-'));
const processes = [];
const signals = new EventEmitter();
const requests = [];
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  requests.push({ res, body: JSON.parse(body) }); signals.emit('request');
});
const deadline = (promise, ms = 20000) => {
  let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Smoke test deadline exceeded')), ms); })]).finally(() => clearTimeout(timer));
};
async function modelRequest(index) {
  while (requests.length <= index) await deadline(once(signals, 'request'));
  return requests[index];
}
function finish(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta, reason = null) => ({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason: reason }] });
  res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: text }))}\n\n`);
  res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`); res.end('data: [DONE]\n\n');
}
function start(env, extra = []) {
  const args = ['--mode', 'rpc', '--no-extensions', '--no-skills', '--no-prompt-templates', '--provider', 'live-clone-test', '--model', 'mock', '--thinking', 'high', '-e', join(root, 'tests/fixtures/mock-provider.ts'), '-e', join(root, 'src/extension.ts'), ...extra];
  const child = spawn(process.env.PI_BIN || 'pi', args, { cwd: temp, env, stdio: ['pipe', 'pipe', 'pipe'] }); processes.push(child);
  let generateSummary = false;
  const events = new EventEmitter(); const history = []; const pending = new Map(); let buf = '', stderr = '';
  child.stderr.on('data', x => { stderr += x; });
  const send = x => child.stdin.write(JSON.stringify(x) + '\n');
  child.stdout.on('data', x => {
    buf += x;
    while (buf.includes('\n')) {
      const i = buf.indexOf('\n'); const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
      let event; try { event = JSON.parse(line); } catch { console.error('Non-JSON Pi stdout:', line); continue; }
      history.push(event); events.emit(event.type, event);
      if (event.type === 'response' && pending.has(event.id)) { pending.get(event.id)(event); pending.delete(event.id); }
      if (event.type === 'extension_ui_request') {
        if (event.method === 'select') send({ type: 'extension_ui_response', id: event.id, value: !generateSummary && event.options.some(x => x.startsWith('Generate handoff')) ? event.options[1] : event.options[0] });
        if (event.method === 'editor') send({ type: 'extension_ui_response', id: event.id, value: 'UI reviewed handoff' });
        if (event.method === 'confirm') send({ type: 'extension_ui_response', id: event.id, confirmed: false });
      }
    }
  });
  child.on('exit', code => { if (pending.size) console.error('Pi exited', code, stderr); });
  let seq = 0;
  async function command(type, data = {}) {
    const id = `r${++seq}`;
    const response = new Promise(resolve => pending.set(id, resolve)); send({ type, id, ...data });
    let r; try { r = await deadline(response); } catch (e) { throw new Error(`${e.message}; Pi stderr=${stderr}; last events=${JSON.stringify(history.slice(-5))}`); }
    assert.equal(r.success, true, JSON.stringify(r)); return r.data;
  }
  return { child, command, events, history, chooseSummary: () => { generateSummary = true; }, stderr: () => stderr };
}
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  for (const sub of ['bin', 'config', 'runtime', 'state', 'sessions']) mkdirSync(join(temp, sub), { mode: 0o700 });
  const fake = `#!/usr/bin/env node\nconst a=process.argv.slice(2); console.log(JSON.stringify({result:a[0]==='tab'&&a[1]==='create'?{tab:{tab_id:'wTest:t2'},root_pane:{pane_id:'wTest:p2'}}:{ok:true}}));\n`;
  writeFileSync(join(temp, 'bin/herdr'), fake, { mode: 0o700 });
  const env = { ...process.env, PATH: join(temp, 'bin') + ':' + process.env.PATH, PI_CODING_AGENT_DIR: join(temp, 'config'), PI_CODING_AGENT_SESSION_DIR: join(temp, 'sessions'), PI_TWIN_STATE_DIR: join(temp, 'state'), XDG_RUNTIME_DIR: join(temp, 'runtime'), PI_OFFLINE: '1', PI_TELEMETRY: '0', HERDR_PANE_ID: 'wTest:p1', HERDR_SOCKET_PATH: join(temp, 'fake-herdr.sock'), LIVE_CLONE_TEST_URL: `http://127.0.0.1:${server.address().port}/v1` };
  delete env.HERDR_CLIENT_SOCKET_PATH;
  const original = start(env, ['--name', 'Sift']);
  const state = await original.command('get_state');
  assert.equal(state.thinkingLevel, 'high');
  const peers = await discover({ dir: await runtimeDir(env) });
  const endpoint = peers.find(p => p.sessionId === state.sessionId);
  assert.ok(endpoint, 'source extension endpoint registered');
  await original.command('prompt', { message: 'SOURCE BUSY TASK MUST NOT APPEAR IN CLONE' });
  const sourceCall = await modelRequest(0);
  const cloned = await request(endpoint, { method: 'clone', id: 'smoke-clone-1' }, { timeoutMs: 20000 });
  assert.equal(cloned.status, 'launched'); assert.equal(cloned.name, 'Sift[a]');
  assert.equal((await original.command('get_state')).isStreaming, true);
  assert.ok(!readFileSync(cloned.file, 'utf8').includes('SOURCE BUSY TASK'));
  const side = start({ ...env, HERDR_PANE_ID: 'wTest:p2' }, ['--session', cloned.file]);
  const sideState = await side.command('get_state');
  assert.equal(sideState.sessionId, cloned.childId); assert.equal(sideState.thinkingLevel, 'high');
  assert.equal(sideState.model.id, 'mock'); assert.equal(sideState.sessionName, 'Sift[a]');
  const sideSettled = once(side.events, 'agent_settled');
  await side.command('prompt', { message: 'Discuss tangent' });
  finish((await modelRequest(1)).res, 'A useful tangent conclusion'); await deadline(sideSettled);
  const merge = mergeEnvelope({ origin: cloned.lineage, sourceFile: cloned.file, text: 'Background result from tangent' });
  assert.equal((await request(endpoint, { method: 'merge', envelope: merge })).status, 'queued');
  assert.equal((await original.command('get_state')).isStreaming, true);
  const sourceSettled = once(original.events, 'agent_settled'); finish(sourceCall.res, 'Original task completed'); await deadline(sourceSettled);
  assert.equal((await request(endpoint, { method: 'receipt', id: merge.id })).status, 'delivered');
  const messages = (await original.command('get_messages')).messages;
  const resultIndex = messages.findIndex(m => m.role === 'assistant');
  const mergeIndex = messages.findIndex(m => m.customType === 'pi-twin-merge');
  assert.ok(mergeIndex > resultIndex, 'merge follows completed original task');
  assert.equal((await request(endpoint, { method: 'merge', envelope: merge })).status, 'delivered');
  await side.command('prompt', { message: '/merge' });
  assert.ok(side.history.some(e => e.type === 'extension_ui_request' && e.method === 'editor'));
  assert.ok((await original.command('get_messages')).messages.some(m => m.customType === 'pi-twin-merge' && m.content.includes('UI reviewed handoff')));
  assert.equal(requests.length, 2, 'clone/merge made no model requests');
  side.chooseSummary();
  await side.command('set_model', { provider: 'pi-router', modelId: 'auto' });
  await side.command('prompt', { message: '/merge' });
  const summaryCall = await modelRequest(2);
  assert.equal(summaryCall.body.model, 'mock', 'summary uses last successful concrete model, not Auto rerouting');
  assert.ok(JSON.stringify(summaryCall.body).includes('ENTIRE discussion/work since this live-clone split'));
  const editorOpened = new Promise(resolve => {
    const handler = event => { if (event.method === 'editor') { side.events.off('extension_ui_request', handler); resolve(event); } };
    side.events.on('extension_ui_request', handler);
  });
  finish(summaryCall.res, 'Goal: explore a tangent. Decision: adopt the useful conclusion. Unresolved: validate assumptions.');
  const editor = await deadline(editorOpened);
  assert.equal((await side.command('get_state')).model.provider, 'pi-router', 'Auto selection restored after summary');
  assert.ok(JSON.stringify(editor).includes('Unresolved: validate assumptions.'), 'generated summary must prefill the review');
  assert.equal(requests.length, 3, 'summary is exactly one explicitly requested model turn');

  const unusedClone = await request(endpoint, { method: 'clone', id: 'unused-clone' }, { timeoutMs: 20000 });
  const unused = start({ ...env, HERDR_PANE_ID: 'wTest:p3' }, ['--session', unusedClone.file]);
  await unused.command('get_state');
  const exited = once(unused.child, 'exit');
  unused.child.stdin.write(JSON.stringify({ type: 'prompt', id: 'empty-merge', message: '/merge' }) + '\n');
  await deadline(exited);
  assert.ok(!unused.history.some(e => e.type === 'extension_ui_request' && ['select', 'editor', 'confirm'].includes(e.method)), 'unused clone exits without merge dialogs');
  assert.ok(readFileSync(unusedClone.file, 'utf8').includes(unusedClone.childId), 'saved conversation retained');
  assert.equal(requests.length, 3, 'empty merge must not call a model');
  await original.command('prompt', { message: '/split' });
  const splitStatus = await request(endpoint, { method: 'status' });
  assert.ok(splitStatus.clones.some(c => c.name === 'Sift[c]' && c.status === 'launched'), '/split launches the next lettered child');
  assert.equal(requests.length, 3, '/split is a command, not a model prompt');
  await original.command('prompt', { message: '/test-reload' });
  await original.command('prompt', { message: '/split' });
  const refreshed = (await discover({ dir: await runtimeDir(env) })).find(p => p.sessionId === state.sessionId);
  assert.ok(refreshed, 'reload republishes the source endpoint');
  assert.ok((await request(refreshed, { method: 'status' })).clones.some(c => c.name === 'Sift[d]' && c.status === 'launched'), 'split still works after real Pi resource reload');
  assert.equal(requests.length, 3);
  const errors = [...original.history, ...side.history, ...unused.history].filter(e => e.type === 'extension_error' || (e.type === 'extension_ui_request' && e.notifyType === 'error'));
  assert.deepEqual(errors, []);
  console.log('PASS: real Pi busy checkpoint, independent child context/model/effort, durable queued merge, idempotency, editable UI handoff; explicit summary generation and automatic unused-clone exit. Herdr CLI mocked.');
} finally {
  for (const { res } of requests) if (!res.writableEnded) res.end();
  await Promise.all(processes.map(p => new Promise(resolve => { if (p.exitCode !== null) return resolve(); p.once('exit', resolve); p.kill('SIGTERM'); const timer = setTimeout(() => { p.kill('SIGKILL'); resolve(); }, 5000); timer.unref(); })));
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  rmSync(temp, { recursive: true, force: true });
}
