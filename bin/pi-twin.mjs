#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { discover, request } from '../src/ipc.mjs';

const args = process.argv.slice(2);
const operation = args.shift();
const options = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!['--pane', '--session', '--id', '--socket', '--expected-session'].includes(args[i]) || !args[i + 1]) fail('Invalid arguments');
  if (options.has(args[i])) fail('Duplicate argument');
  options.set(args[i], args[i + 1]);
}
function fail(message) { console.error(`${message}\nUsage: pi-twin clone|merge|status --pane ID [--id REQUEST_ID] [--socket HERDR_SOCKET]\n       pi-twin receipt --session SESSION_ID --id MERGE_ID`); process.exit(1); }
if (!['clone', 'merge', 'status', 'receipt'].includes(operation)) fail('Choose an operation');
if (Number(options.has('--pane')) + Number(options.has('--session')) !== 1) fail('Choose exactly one --pane or --session');
if (operation === 'receipt' && !options.has('--id')) fail('receipt requires --id');

const operationId = options.get('--id') ?? randomUUID();
try {
  const socket = options.get('--socket') ?? process.env.HERDR_SOCKET_PATH ?? '';
  const peers = (await discover()).filter(p => p.herdrSocket === socket && (!options.has('--expected-session') || p.sessionId === options.get('--expected-session')) && (options.has('--pane') ? p.paneId === options.get('--pane') : p.sessionId === options.get('--session')));
  if (peers.length !== 1) throw new Error(peers.length ? 'Multiple endpoints match; use exact --session and --socket' : 'No live-clone endpoint for this agent. Load the extension in that Pi session first.');
  const method = operation === 'merge' ? 'merge-ui' : operation;
  const result = await request(peers[0], { method, id: operationId }, { timeoutMs: operation === 'clone' ? 40000 : 5000 });
  console.log(JSON.stringify(result));
  if (operation === 'clone' && result.status !== 'launched') {
    console.error(`Clone request ${operationId} is ${result.status}, not confirmed launched. Inspect the retained record/session before taking another action.`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`pi-twin: ${error.message}${operation === 'clone' ? `\nClone request ID: ${operationId}. Preserve this ID when checking/retrying an uncertain request; a fresh ID creates a different clone.` : ''}`);
  process.exitCode = 1;
}
