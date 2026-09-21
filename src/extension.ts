import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Controller } from './controller.mjs';
import { originOf, transcriptSince, mergeEnvelope, MAX_MERGE_BYTES } from './model.mjs';
import { createHerdr } from './herdr.mjs';
import { stateDir } from './storage.mjs';
import { runtimeDir, startEndpoint, request, discover } from './ipc.mjs';

export default function liveClone(pi: ExtensionAPI) {
  let controller: Controller | undefined;
  let endpoint: Awaited<ReturnType<typeof startEndpoint>> | undefined;
  let uiBusy = false;
  let generation = 0;
  const host = createHerdr({ extensionPath: fileURLToPath(import.meta.url) });
  const notify = (ctx: ExtensionContext, text: string, type: 'info' | 'warning' | 'error' = 'info') => { if (ctx.hasUI) ctx.ui.notify(text, type); };
  const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

  async function peer(parentId: string) {
    const peers = await discover({ dir: await runtimeDir() });
    const found = peers.filter((p: any) => p.sessionId === parentId && p.herdrSocket === host.socketPath);
    if (found.length !== 1) throw new Error('Original session is not connected. Resume it with this extension, then retry the handoff.');
    return found[0];
  }

  async function mergeUI(ctx: ExtensionContext, args = '') {
    if (uiBusy) return notify(ctx, 'A clone dialog is already open.', 'warning');
    if (!ctx.isIdle()) return notify(ctx, 'Let the clone finish before reviewing its handoff. The original can remain busy.', 'warning');
    if (!ctx.hasUI) throw new Error('Merge preview requires interactive Pi');
    const origin = originOf(ctx.sessionManager);
    if (!origin) return notify(ctx, 'This session is not a live clone.', 'warning');
    const myGeneration = generation;
    uiBusy = true;
    try {
      const mode = args.includes('--full') ? 'Full text transcript' : await ctx.ui.select('Merge back: choose what to review', ['Edit summary (prefill last reply)', 'Full text transcript']);
      if (!mode) return;
      let text: string;
      const kind = mode === 'Full text transcript' ? 'transcript' : 'summary';
      if (kind === 'transcript') text = transcriptSince(ctx.sessionManager, origin);
      else {
        const branch = ctx.sessionManager.getBranch();
        const start = branch.findIndex((e: any) => e.type === 'custom' && e.customType === 'pi-live-clone-origin-v1' && e.data?.childId === origin.childId);
        const reply = branch.slice(start + 1).filter((e: any) => e.type === 'message' && e.message.role === 'assistant').at(-1) as any;
        text = (reply?.message?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') || 'Conclusions:\n\nRecommendations:\n\nUnresolved questions:\n\nFiles changed / tests:\n';
      }
      if (Buffer.byteLength(text) > MAX_MERGE_BYTES) throw new Error('Discussion exceeds the 96 KiB handoff limit. Use /clone-handoff to request a concise summary, then merge that. Nothing was truncated or sent.');
      const edited = await ctx.ui.editor(`Review ${kind} for ${origin.parentName}; shared files are already shared`, text);
      if (!edited?.trim()) return;
      const purpose = await ctx.ui.select('How should the original use this?', ['Background information only', 'Act on the handoff after finishing current task']);
      if (!purpose) return;
      if (generation !== myGeneration) throw new Error('Session changed while reviewing; handoff cancelled');
      const act = purpose.startsWith('Act');
      const sourceFile = ctx.sessionManager.getSessionFile();
      const id = createHash('sha256').update(JSON.stringify({ childId: origin.childId, kind, text: edited, act })).digest('hex');
      const envelope = mergeEnvelope({ origin, sourceFile, text: edited, kind, act, id });
      const outbox = controller?.outgoing;
      // Keep the exact envelope across retries, including its original creation timestamp.
      const saved = outbox?.get(id);
      const stableEnvelope = saved?.envelope ?? envelope;
      outbox?.put({ id, envelope: stableEnvelope, status: 'prepared', updatedAt: new Date().toISOString() });
      const parent = await peer(origin.parentId);
      if (generation !== myGeneration) throw new Error('Session changed while locating the original; handoff not sent');
      const receipt = await request(parent, { method: 'merge', envelope: stableEnvelope }, { timeoutMs: 5000 }) as { status: string };
      // Delivery may have succeeded even if our session switched while awaiting its receipt.
      outbox?.put({ id, envelope: stableEnvelope, status: receipt.status, updatedAt: new Date().toISOString() });
      if (generation !== myGeneration) return;
      if (receipt.status === 'delivered') {
        notify(ctx, `Handoff imported by ${origin.parentName}. Saved clone session retained.`);
        if (ctx.isIdle() && await ctx.ui.confirm('Close this clone?', 'The handoff was imported. Its saved conversation will remain available.')) {
          if (generation === myGeneration && ctx.isIdle()) ctx.shutdown();
        }
      } else {
        notify(ctx, `Handoff queued for ${origin.parentName}; it will be imported after that agent settles. Clone kept open. Use /clone-merge-status to check later.`);
      }
    } catch (e) { notify(ctx, errorText(e), 'error'); }
    finally { uiBusy = false; }
  }

  pi.on('session_start', async (_event, ctx) => {
    const mine = ++generation;
    const dir = await runtimeDir();
    const current = new Controller({ pi, ctx, dir: stateDir(), launch: (child: any) => host.launch(child) });
    controller = current;
    const origin = originOf(ctx.sessionManager);
    try {
      endpoint = await startEndpoint({
        sessionId: ctx.sessionManager.getSessionId(), dir,
        metadata: { name: pi.getSessionName(), paneId: host.paneId, herdrSocket: host.socketPath, cwd: ctx.cwd },
        handle: async (r: any) => {
          if (mine !== generation) throw new Error('Stale session endpoint');
          if (r.method === 'status') return current.status();
          if (r.method === 'clone') return current.clone(r.id);
          if (r.method === 'merge') return current.acceptMerge(r.envelope);
          if (r.method === 'receipt') return current.receipt(r.id);
          if (r.method === 'merge-ui') {
            if (!ctx.hasUI) throw new Error('Merge preview requires interactive Pi');
            void mergeUI(current.ctx, '').catch((e) => notify(current.ctx, errorText(e), 'error'));
            return { status: 'preview-requested' };
          }
          throw new Error('Unsupported live-clone operation');
        },
      });
      await host.publish({ name: pi.getSessionName(), sessionId: ctx.sessionManager.getSessionId(), clone: !!origin, enabled: true });
      if (origin) notify(ctx, `${pi.getSessionName()}: shares working directory with ${origin.parentName}. File changes affect both agents.`, 'warning');
      current.drain();
    } catch (e) { notify(ctx, `Live clone: ${errorText(e)}`, 'error'); }
  });
  pi.on('before_agent_start', (_event, ctx) => { controller?.beforeRun(ctx); });
  pi.on('agent_settled', (_event, ctx) => {
    try { controller?.settle(ctx); }
    catch (e) { notify(ctx, `Handoff retained for recovery: ${errorText(e)}`, 'error'); }
  });
  pi.on('model_select', (_event, ctx) => { controller?.update(ctx); });
  pi.on('thinking_level_select', (_event, ctx) => { controller?.update(ctx); });
  pi.on('session_tree', (_event, ctx) => { controller?.update(ctx); });
  pi.on('session_info_changed', async (_event, ctx) => {
    controller?.update(ctx);
    try { if (originOf(ctx.sessionManager)) await host.publish({ name: pi.getSessionName(), sessionId: ctx.sessionManager.getSessionId(), clone: true, enabled: true }); }
    catch (e) { notify(ctx, `Clone name could not be published: ${errorText(e)}`, 'error'); }
  });
  pi.on('session_shutdown', async () => {
    ++generation; controller?.stop(); controller = undefined;
    await endpoint?.close(); endpoint = undefined;
    await host.publish({ enabled: false }).catch(() => {});
  });

  pi.registerCommand('live-clone', {
    description: 'Open an independent clone in a new Herdr tab; keep this agent running',
    handler: async (_args, ctx) => {
      try {
        if (!controller) throw new Error('Live clone is not initialized');
        controller.update(ctx);
        const result = await controller.clone(randomUUID());
        notify(ctx, `${result.name}: ${result.status}. Original remains here; shared files are not isolated.`);
      } catch (e) { notify(ctx, errorText(e), 'error'); }
    },
  });
  pi.registerCommand('merge-back', { description: 'Review and send this clone’s handoff to its original', handler: (args, ctx) => mergeUI(ctx, args) });
  pi.registerCommand('clone-handoff', {
    description: 'Ask this clone to draft a concise handoff (one normal agent turn)',
    handler: async (_args, ctx) => {
      if (!originOf(ctx.sessionManager)) return notify(ctx, 'This is not a live clone.', 'warning');
      if (!ctx.isIdle()) return notify(ctx, 'Wait for the clone to finish first.', 'warning');
      pi.sendUserMessage('Write a concise handoff for the original agent, covering ONLY our discussion/work since this live-clone split: conclusions, recommendations, unresolved questions, files changed and tests actually run. Distinguish proposals from completed work. Do not execute tools or change files for this request. Output the handoff only; the user will review it with /merge-back.');
    },
  });
  pi.registerCommand('clone-merge-status', {
    description: 'Check whether this clone’s latest handoff was imported; optionally close',
    handler: async (_args, ctx) => {
      const myGeneration = generation;
      try {
        const origin = originOf(ctx.sessionManager);
        if (!origin) throw new Error('This is not a live clone');
        const parent = await peer(origin.parentId);
        const last = controller?.outgoing.list().sort((a: any, b: any) => a.updatedAt.localeCompare(b.updatedAt)).at(-1);
        if (!last) return notify(ctx, 'No handoff has been submitted from this clone.');
        const receipt = await request(parent, { method: 'receipt', id: last.id }) as { status: string };
        if (generation !== myGeneration) return;
        notify(ctx, `${origin.parentName}: handoff ${receipt.status}. Saved clone session retained.`);
        if (receipt.status === 'delivered' && ctx.isIdle() && ctx.hasUI && await ctx.ui.confirm('Close this clone?', 'The original has imported the handoff; the saved conversation remains available.')) {
          if (generation === myGeneration && ctx.isIdle()) ctx.shutdown();
        }
      } catch (e) { notify(ctx, errorText(e), 'error'); }
    },
  });
}
