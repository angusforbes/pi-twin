import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { Controller as ControllerType } from './controller.mjs';
import { loadCore } from './load-core.mjs';
import { pickHistory } from './history-picker.ts';

export default async function liveClone(pi: ExtensionAPI) {
  const core = await loadCore(SessionManager) as {
    controller: typeof import('./controller.mjs'); model: typeof import('./model.mjs');
    herdr: typeof import('./herdr.mjs'); storage: typeof import('./storage.mjs'); ipc: typeof import('./ipc.mjs'); wait: typeof import('./wait.mjs'); config: typeof import('./config.mjs');
  };
  const { Controller } = core.controller;
  const { originOf, hasCloneActivity, handoffModel, transcriptSince, mergeEnvelope, MAX_MERGE_BYTES } = core.model;
  const { createHerdr } = core.herdr;
  const { stateDir } = core.storage;
  const { runtimeDir, startEndpoint, request, discover } = core.ipc;
  const { waitForReceipt } = core.wait;
  let controller: ControllerType | undefined;
  let endpoint: Awaited<ReturnType<typeof startEndpoint>> | undefined;
  let uiBusy = false;
  let generation = 0;
  let cancelWait: AbortController | undefined;
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

  async function closeTwin(ctx: ExtensionContext) {
    const mine = generation, leaf = ctx.sessionManager.getLeafId(), sessionId = ctx.sessionManager.getSessionId();
    const unchanged = () => mine === generation && ctx.isIdle() && ctx.sessionManager.getSessionId() === sessionId && ctx.sessionManager.getLeafId() === leaf;
    await host.closeSelf(sessionId, unchanged);
    // A real Herdr pane close usually terminates us first. Non-Herdr hosts and
    // test adapters still need Pi's graceful shutdown path.
    if (unchanged()) { notify(ctx, 'Closing twin; saved session retained.'); ctx.shutdown(); }
  }

  async function finishMerge(ctx: ExtensionContext, origin: any, record: any, receipt: { status: string }, mine: number) {
    const unchanged = () => generation === mine && ctx.isIdle() && record.reviewedLeafId !== undefined && ctx.sessionManager.getLeafId() === record.reviewedLeafId;
    if (generation !== mine) return;
    if (!unchanged()) return notify(ctx, 'Handoff submitted, but this twin has changed since review. Keeping it open.', 'warning');
    if (receipt.status === 'queued') {
      const abort = new AbortController(); cancelWait = abort;
      let dialogError: unknown;
      const dialog = ctx.ui.select(`Waiting for ${origin.parentName} to import the handoff…`, ['Keep twin open — stop waiting'], { signal: abort.signal })
        .then(() => { if (!abort.signal.aborted) abort.abort(); }, error => { dialogError = error; abort.abort(); });
      try {
        const imported = await waitForReceipt({
          signal: abort.signal, isCurrent: unchanged,
          read: async () => request(await peer(origin.parentId), { method: 'receipt', id: record.id }, { timeoutMs: 5000 }) as Promise<{ status: string }>,
        });
        if (dialogError) throw dialogError;
        if (!imported) {
          if (generation === mine) notify(ctx, 'Stopped waiting; twin kept open. The queued handoff is NOT cancelled. Use /twin-merge-status later.');
          return;
        }
        receipt = imported;
      } finally {
        abort.abort(); await dialog;
        if (cancelWait === abort) cancelWait = undefined;
      }
    }
    if (receipt.status !== 'delivered') throw new Error(`Handoff ${receipt.status}; twin kept open.`);
    if (!unchanged()) return notify(ctx, 'Handoff imported, but this twin has new activity. Keeping it open.', 'warning');
    controller?.outgoing.put({ ...record, status: 'delivered', updatedAt: new Date().toISOString() });
    notify(ctx, `Handoff imported by ${origin.parentName}; saved session retained.`);
    await closeTwin(ctx);
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
    if (uiBusy) return notify(ctx, 'A twin dialog is already open.', 'warning');
    if (!ctx.isIdle()) return notify(ctx, 'Let the clone finish before reviewing its handoff. The original can remain busy.', 'warning');
    if (!ctx.hasUI) throw new Error('Merge preview requires interactive Pi');
    const origin = originOf(ctx.sessionManager);
    if (!origin) return notify(ctx, 'This session is not a live clone.', 'warning');
    if (origin.mergeAllowed === false) return notify(ctx, 'This is a permanent fork; merge-back is disabled.', 'warning');
    if (!hasCloneActivity(ctx.sessionManager, origin)) {
      notify(ctx, 'No interaction since cloning; nothing to merge. Exiting this clone; saved session retained.');
      await closeTwin(ctx);
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
      if (Buffer.byteLength(text) > MAX_MERGE_BYTES) throw new Error('Discussion exceeds the 96 KiB handoff limit. Use /twin-handoff to request a concise summary, then merge that. Nothing was truncated or sent.');
      const edited = await ctx.ui.editor(`Review ${kind} for ${origin.parentName}${origin.kind === 'tree' ? ' — historical context; parent may have moved on' : ''}; shared files are already shared`, text);
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
      const reviewedLeafId = ctx.sessionManager.getLeafId();
      const parent = await peer(origin.parentId);
      if (generation !== myGeneration || !ctx.isIdle() || ctx.sessionManager.getLeafId() !== reviewedLeafId) throw new Error('Session changed while locating the original; handoff not sent');
      const receipt = await request(parent, { method: 'merge', envelope: stableEnvelope }, { timeoutMs: 5000 }) as { status: string };
      // Delivery may have succeeded even if our session switched while awaiting its receipt.
      const record = { id, envelope: stableEnvelope, reviewedLeafId, status: receipt.status, updatedAt: new Date().toISOString() };
      outbox?.put(record);
      await finishMerge(ctx, origin, record, receipt, myGeneration);
    } catch (e) { notify(ctx, errorText(e), 'error'); }
    finally { uiBusy = false; }
  }

  pi.on('session_start', async (_event, ctx) => {
    const mine = ++generation;
    const dir = await runtimeDir();
    const current = new Controller({ pi, ctx, dir: stateDir(), launch: (child: any) => host.launch(child), resolveName: () => host.displayName(), nameTemplate: () => core.config.readNameTemplate() });
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
      await host.publish({ name: pi.getSessionName(), sessionId: ctx.sessionManager.getSessionId(), clone: !!origin, mergeable: origin?.mergeAllowed !== false, enabled: true });
      if (origin?.history?.beforeUser && ctx.hasUI && !hasCloneActivity(ctx.sessionManager, origin) && !ctx.sessionManager.getEntries().some((e: any) => e.type === 'custom' && e.customType === 'pi-twin-draft-restored' && e.data?.childId === origin.childId)) {
        if (!ctx.ui.getEditorText()) {
          ctx.ui.setEditorText(origin.history.draft ?? '');
          pi.appendEntry('pi-twin-draft-restored', { childId: origin.childId });
        }
        if (origin.history.omittedAttachments) notify(ctx, 'The selected prompt had attachments. Only text is prefilled; reattach images/files before sending. Original attachments remain in the source session.', 'warning');
      }
      if (origin?.mergeAllowed === false) notify(ctx, 'Permanent fork: merge-back is disabled. Choose a distinct /name when ready.', 'info');
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
        notify(ctx, 'Handoff generation did not complete normally. Nothing was merged; retry /twin-merge when ready.', 'warning');
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
    try { if (originOf(ctx.sessionManager)) await host.publish({ name: pi.getSessionName(), sessionId: ctx.sessionManager.getSessionId(), clone: true, mergeable: originOf(ctx.sessionManager)?.mergeAllowed !== false, enabled: true }); }
    catch (e) { notify(ctx, `Clone name could not be published: ${errorText(e)}`, 'error'); }
  });
  pi.on('session_shutdown', async () => {
    ++generation; cancelWait?.abort(); cancelWait = undefined; reviewAfterSummary = undefined; controller?.stop(); controller = undefined;
    await endpoint?.close(); endpoint = undefined;
    await host.publish({ enabled: false }).catch(() => {});
  });

  async function historicalSplit(ctx: ExtensionContext, kind: 'tree' | 'fork') {
    if (uiBusy) return notify(ctx, 'A twin dialog is already open.', 'warning');
    const mine = generation;
    const current = controller;
    uiBusy = true;
    try {
      if (!current) throw new Error('Pi-twin is not initialized');
      const entryId = await pickHistory(ctx, kind);
      if (!entryId) return;
      if (mine !== generation) throw new Error('Session changed; selection cancelled');
      const entry = ctx.sessionManager.getEntry(entryId);
      if (!entry) throw new Error('Selected history point is unavailable');
      let beforeUser = kind === 'fork';
      if (kind === 'tree' && entry.type === 'message' && entry.message.role === 'user') {
        const mode = await ctx.ui.select('Historical user prompt: where should the twin start?', ['Before this prompt — prefill text, do not send', 'Through this message — context only, do not execute']);
        if (!mode) return;
        beforeUser = mode.startsWith('Before');
      }
      if (mine !== generation) throw new Error('Session changed; selection cancelled');
      const details = `${beforeUser ? 'Before' : 'Through'} entry ${entryId} (${entry.timestamp}). ${kind === 'fork' ? 'Permanent fork: no merge-back.' : 'Historical twin: reviewed handoffs return to the parent’s current branch.'} Files remain current and shared; no prompt is submitted.`;
      if (!await ctx.ui.confirm(kind === 'fork' ? 'Open permanent fork in a new tab?' : 'Open historical twin in a new tab?', details)) return;
      if (mine !== generation) throw new Error('Session changed; split cancelled');
      current.update(ctx);
      const result = await current.clone(randomUUID(), { entryId, kind, beforeUser });
      if (mine === generation) notify(ctx, `${result.name}: ${result.status}. Original conversation unchanged; shared files are not isolated.`);
    } catch (e) { notify(ctx, errorText(e), 'error'); }
    finally { uiBusy = false; }
  }
  pi.registerCommand('twin-tree', { description: 'Choose any history point and open a new live twin without moving this session', handler: (_args, ctx) => historicalSplit(ctx, 'tree') });
  pi.registerCommand('twin-fork', { description: 'Choose a past user prompt and open an independent permanent fork (no merge-back)', handler: (_args, ctx) => historicalSplit(ctx, 'fork') });

  pi.registerCommand('twin-split', {
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
  pi.registerCommand('twin-merge', { description: 'Review and send this clone’s handoff to its original', handler: (args, ctx) => mergeUI(ctx, args) });
  pi.registerCommand('twin-handoff', {
    description: 'Ask this clone to draft a concise handoff (one normal agent turn)',
    handler: async (_args, ctx) => {
      if (!originOf(ctx.sessionManager)) return notify(ctx, 'This is not a live clone.', 'warning');
      if (!ctx.isIdle()) return notify(ctx, 'Wait for the clone to finish first.', 'warning');
      try { await startSummary(ctx, false); }
      catch (e) { notify(ctx, errorText(e), 'error'); }
    },
  });
  pi.registerCommand('twin-merge-status', {
    description: 'Wait for the latest handoff to be imported, then close the unchanged twin',
    handler: async (_args, ctx) => {
      if (uiBusy || !ctx.isIdle()) return notify(ctx, 'Finish the current task or dialog first.', 'warning');
      const myGeneration = generation;
      uiBusy = true;
      try {
        const origin = originOf(ctx.sessionManager);
        if (!origin) throw new Error('This is not a live clone');
        if (origin.mergeAllowed === false) throw new Error('Permanent forks do not merge back');
        const parent = await peer(origin.parentId);
        const last = controller?.outgoing.list().sort((a: any, b: any) => a.updatedAt.localeCompare(b.updatedAt)).at(-1);
        if (!last) return notify(ctx, 'No handoff has been submitted from this clone.');
        const receipt = await request(parent, { method: 'receipt', id: last.id }) as { status: string };
        if (generation !== myGeneration) return;
        await finishMerge(ctx, origin, last, receipt, myGeneration);
      } catch (e) { notify(ctx, errorText(e), 'error'); }
      finally { uiBusy = false; }
    },
  });
}
