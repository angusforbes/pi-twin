import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { Controller as ControllerType } from './controller.mjs';
import { loadCore } from './load-core.mjs';

export default async function liveClone(pi: ExtensionAPI) {
  const core = await loadCore(SessionManager) as {
    controller: typeof import('./controller.mjs'); model: typeof import('./model.mjs');
    herdr: typeof import('./herdr.mjs'); storage: typeof import('./storage.mjs'); ipc: typeof import('./ipc.mjs');
  };
  const { Controller } = core.controller;
  const { originOf, hasCloneActivity, handoffModel, transcriptSince, mergeEnvelope, MAX_MERGE_BYTES } = core.model;
  const { createHerdr } = core.herdr;
  const { stateDir } = core.storage;
  const { runtimeDir, startEndpoint, request, discover } = core.ipc;
  let controller: ControllerType | undefined;
  let endpoint: Awaited<ReturnType<typeof startEndpoint>> | undefined;
  let uiBusy = false;
  let generation = 0;
  let reviewAfterSummary: { generation: number; sessionId: string; review: boolean; restore?: (ctx: ExtensionContext) => Promise<void> } | undefined;
  const handoffPrompt = 'Write a useful, self-contained handoff for the original agent covering the ENTIRE discussion/work since this live-clone split, not merely the last reply. Include the goal, conclusions and reasons, decisions, recommendations, unresolved questions, files changed and tests actually run. Distinguish proposals from completed work. Omit empty sections. Do not execute tools or change files for this request. Output the handoff only; the user will review it before anything is sent.';
  const host = createHerdr({ extensionPath: fileURLToPath(import.meta.url) });
  const notify = (ctx: ExtensionContext, text: string, type: 'info' | 'warning' | 'error' = 'info') => { if (ctx.hasUI) ctx.ui.notify(text, type); };
  const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

  async function peer(parentId: string) {
    const peers = await discover({ dir: await runtimeDir() });
    const found = peers.filter((p: any) => p.sessionId === parentId && p.herdrSocket === host.socketPath);
    if (found.length !== 1) throw new Error('Original session is not connected. Resume it with this extension, then retry the handoff.');
    return found[0];
  }

  async function startSummary(ctx: ExtensionContext, review: boolean) {
    const mine = generation;
    const selected = handoffModel(ctx);
    const previous = ctx.model;
    const previousThinking = pi.getThinkingLevel();
    let restore: ((ctx: ExtensionContext) => Promise<void>) | undefined;
    if (selected && previous && (selected.provider !== previous.provider || selected.id !== previous.id)) {
      if (!await pi.setModel(selected)) throw new Error('The last successful model is unavailable; nothing was merged.');
      const pinnedThinking = pi.getThinkingLevel();
      restore = async current => {
        // Never undo a user's intervening model/effort selection or session switch.
        if (generation !== mine || current.model?.provider !== selected.provider || current.model?.id !== selected.id) return;
        const restoreThinking = pi.getThinkingLevel() === pinnedThinking;
        if (await pi.setModel(previous) && restoreThinking) pi.setThinkingLevel(previousThinking);
      };
    }
    if (mine !== generation) throw new Error('Session changed; summary cancelled');
    reviewAfterSummary = { generation: mine, sessionId: ctx.sessionManager.getSessionId(), review, restore };
    try { pi.sendUserMessage(handoffPrompt); }
    catch (e) { reviewAfterSummary = undefined; await restore?.(controller?.ctx ?? ctx); throw e; }
    notify(ctx, `Generating handoff with ${selected?.provider}/${selected?.id}.${review ? ' Review opens when it finishes; nothing is sent automatically.' : ''}`);
  }

  async function mergeUI(ctx: ExtensionContext, args = '') {
    if (uiBusy) return notify(ctx, 'A clone dialog is already open.', 'warning');
    if (!ctx.isIdle()) return notify(ctx, 'Let the clone finish before reviewing its handoff. The original can remain busy.', 'warning');
    if (!ctx.hasUI) throw new Error('Merge preview requires interactive Pi');
    const origin = originOf(ctx.sessionManager);
    if (!origin) return notify(ctx, 'This session is not a live clone.', 'warning');
    if (!hasCloneActivity(ctx.sessionManager, origin)) {
      notify(ctx, 'No interaction since cloning; nothing to merge. Exiting this clone; saved session retained.');
      ctx.shutdown();
      return;
    }
    const myGeneration = generation;
    uiBusy = true;
    try {
      const mode = args.includes('--full') ? 'Full text transcript' : args.includes('--draft') ? 'Edit last reply (no summarization)' : await ctx.ui.select('Agent Merge: choose what to review', ['Generate handoff summary (one model turn)', 'Edit last reply (no summarization)', 'Full text transcript']);
      if (!mode) return;
      if (generation !== myGeneration || !ctx.isIdle()) throw new Error('Session changed or became busy; handoff cancelled');
      if (mode.startsWith('Generate')) {
        await startSummary(ctx, true);
        return;
      }
      let text: string;
      const kind = mode === 'Full text transcript' ? 'transcript' : 'summary';
      if (kind === 'transcript') text = transcriptSince(ctx.sessionManager, origin);
      else {
        const branch = ctx.sessionManager.getBranch();
        const start = branch.findIndex((e: any) => e.type === 'custom' && e.customType === 'pi-twin-origin-v1' && e.data?.childId === origin.childId);
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
    const current = new Controller({ pi, ctx, dir: stateDir(), launch: (child: any) => host.launch(child), resolveName: () => host.displayName() });
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
  pi.on('agent_settled', async (_event, ctx) => {
    try { controller?.settle(ctx); }
    catch (e) { notify(ctx, `Handoff retained for recovery: ${errorText(e)}`, 'error'); }
    const pending = reviewAfterSummary;
    reviewAfterSummary = undefined;
    if (pending && pending.generation === generation && pending.sessionId === ctx.sessionManager.getSessionId()) {
      try { await pending.restore?.(ctx); }
      catch (e) { notify(ctx, `Could not restore model selection: ${errorText(e)}`, 'warning'); }
      if (!pending.review || pending.generation !== generation) return;
      const reply = ctx.sessionManager.getBranch().filter((e: any) => e.type === 'message' && e.message.role === 'assistant').at(-1) as any;
      if (reply?.message.stopReason !== 'stop') {
        notify(ctx, 'Handoff generation did not complete normally. Nothing was merged; retry /merge when ready.', 'warning');
        return;
      }
      // Let settlement and the initiating command finish before opening another UI.
      setTimeout(() => {
        if (pending.generation === generation && ctx.isIdle()) void mergeUI(ctx, '--draft').catch(e => notify(ctx, errorText(e), 'error'));
      }, 0);
    }
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
    ++generation; reviewAfterSummary = undefined; controller?.stop(); controller = undefined;
    await endpoint?.close(); endpoint = undefined;
    await host.publish({ enabled: false }).catch(() => {});
  });

  pi.registerCommand('split', {
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
  pi.registerCommand('merge', { description: 'Review and send this clone’s handoff to its original', handler: (args, ctx) => mergeUI(ctx, args) });
  pi.registerCommand('clone-handoff', {
    description: 'Ask this clone to draft a concise handoff (one normal agent turn)',
    handler: async (_args, ctx) => {
      if (!originOf(ctx.sessionManager)) return notify(ctx, 'This is not a live clone.', 'warning');
      if (!ctx.isIdle()) return notify(ctx, 'Wait for the clone to finish first.', 'warning');
      try { await startSummary(ctx, false); }
      catch (e) { notify(ctx, errorText(e), 'error'); }
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
