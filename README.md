# pi-live-clone

Keep working with an agent **and** open a second live conversation with its background. Designed for the relevant tangent you do not want to inject into a busy agent's task.

Experimental Pi package, initially for **Herdr on Linux/macOS**. Local development; not yet published to npm. The optional Herdr tab-menu patch is separate from installing this extension.

## Behavior

- `/split` opens and focuses a **new Herdr tab**. The original process and conversation stay where they are.
- **Idle source:** copy the current active conversation branch.
- **Busy source:** copy the checkpoint before the prompt initiating the current run. Retain that boundary across retries and queued continuations until Pi fully settles. If the extension did not observe a safe boundary, fail rather than guess.
- Inherit the **current provider/model, effective thinking effort, and working directory**. Context includes the selected branch's compaction checkpoints. Model/effort can diverge independently afterward.
- Names are `Sift[a]`, `Sift[b]`, etc. Name reservations survive restarts. Cloning a clone creates a child of that clone.
- The new agent waits for your input: no automatic prompt, replayed task, or hidden model call.
- **Both agents share files.** Conversation branching does not rewind the filesystem, create a Git branch, or isolate writes. A warning is shown; coordinate overlapping edits as you would between any agents.

Pi's built-in `/clone` remains unchanged. This package uses Pi's native branch extraction on an **independent snapshot manager**, then launches a second process rather than switching the source runtime.

## Try locally

From the package directory, install development dependencies: `npm ci --ignore-scripts`.

Try in a new Pi instance inside Herdr: `pi -e ./src/extension.ts`.

Or register the package for future Pi sessions: `pi install /absolute/path/to/pi-live-clone`.

Existing Pi sessions must load the extension before they can be cloned through its external control interface. Use `/reload` at an appropriate boundary. Do not send reload keystrokes into a busy agent's editor.

For the external CLI, put `bin/pi-live-clone.mjs` on PATH as `pi-live-clone` (for example using a user-owned symlink), or invoke it directly with Node. The CLI itself has no Pi runtime dependency.

Nothing in these instructions requires restarting Herdr. **Installing a patched Herdr binary for native tab-menu entries is a separate deployment decision.**

## Commands

| Command | Meaning |
|---|---|
| `/split` | New live clone tab; original remains active |
| `/clone-handoff` | Ask this clone to draft a concise handoff; explicitly runs one ordinary agent request |
| `/merge` | Review/edit a summary or text transcript and send it to the original |
| `/merge --full` | Review the divergent text transcript |
| `/clone-merge-status` | Check latest submitted handoff; optionally close after confirmed import |

`/merge` offers **Generate handoff summary** (one explicitly requested model turn), **Edit last reply (no summarization)**, or **Full text transcript**. Generation covers the discussion since cloning and opens the review editor when finished. Nothing is sent until you review it and select how the original should use it. `/clone-handoff` remains available as a separate draft-only command.

If a clone has had **no interaction since creation**, `/merge` simply exits that clone without a merge or confirmation dialog. Its saved session remains. Inherited history, the clone notice, and settings changes do not count as interaction; new messages, imported context, and discussion on abandoned branches do. Busy clones are never automatically exited.

During merge review choose **background information only** (default) or explicitly ask the original to act after its current task. A busy original receives nothing mid-task: the handoff lives in a durable queue until full `agent_settled`.

The handoff is one attributed custom message, not replayed assistant/tool history. Duplicate submissions of the same reviewed content are idempotent. The original's model settings are not overwritten. Files are not copied or merged: with a shared directory, edits already happened.

Close is offered only after confirmed import; queued or ambiguous outcomes keep the clone open. Saved session files are never deleted. A queued handoff can be checked later with `/clone-merge-status`.

Full transcript mode means **text transcript**: private thinking is not included, images are explicitly marked omitted and remain in the saved session. A 96 KiB content cap fails visibly rather than silently truncating; use a summary for large conversations.

## External control / tab-menu adapter

The extension exposes a private, local Unix socket while the session is running. An external action can clone the agent without typing into its terminal or cancelling tools.

`pi-live-clone clone --pane w8:pS`

`pi-live-clone merge --pane w8:pT`

`pi-live-clone status --pane w8:pS`

Use `--session SESSION_ID` instead of `--pane` for stable targeting. `--socket HERDR_SOCKET` disambiguates Herdr instances. `--id REQUEST_ID` makes an external clone request safely identifiable; an ambiguous launch is retained, not automatically retried.

The extension advertises `live_clone=1`, `live_clone_session=<session ID>`, and (on clones) `live_clone_parent=1` pane metadata. Menu adapters pass `--expected-session ID` to refuse an action if that pane switched sessions after the menu opened. The optional Herdr patch adds native context-menu actions using those capabilities. Unpatched Herdr still works through `/split` and the CLI. Never use `herdr agent prompt` as a substitute for this private control channel on a busy source.

## Storage and security

- Endpoint descriptors and sockets: `$XDG_RUNTIME_DIR/pi-live-clone`, or a uid-specific private temporary directory. Descriptors are 0600, directories 0700, requests require session identity and an endpoint token.
- Durable lineage, name reservations, and merge queues: `$XDG_STATE_HOME/pi-live-clone`, default `~/.local/state/pi-live-clone`. `PI_LIVE_CLONE_STATE_DIR` overrides this for tests/development. Do not delete while pending handoffs matter.
- Clone conversations: normal Pi session directory, with a fresh ID, original session path, and this extension's origin marker.
- Startup claims fail closed rather than stealing a possibly live lock. If a process crashes during the brief endpoint-startup window, the error identifies the leftover `.json.lock`; verify its process is gone before manually removing that one claim. Ordinary stale endpoint descriptors are recovered automatically.
- Removing the extension stops control endpoints; saved conversations remain normal Pi sessions. Pending handoffs require loading the extension again in the original session.
- This is **same-user IPC, not a sandbox against programs running as you**. No remote listener is exposed. Both agents retain normal tool permissions.

## Tests

`npm run check`

`node tests/rpc-smoke.mjs`

The smoke test starts two real installed Pi processes, uses a local mock model, and mocks Herdr's CLI. It checks busy checkpoint timing, source continuity, inherited settings, queued/imported handoffs, repeat delivery, and editable preview without contacting a paid model or opening desktop tabs. Set `PI_BIN` to override the Pi executable. It does not prove native mouse-menu behavior.

An explicit native-host smoke test is also available: `node tests/native-herdr-smoke.mjs --run`. It creates two disposable real Herdr/Pi tabs, verifies source continuity, clone identity, idle state, cwd, model/effort and sidebar name, then closes only its test tabs and restores focus. No real model request is made. Run it only when brief desktop focus changes are acceptable. It does not exercise the optional context-menu patch.

Tests use Pi 0.85.1. Older Pi versions lacking `agent_settled` are not supported yet. Test other versions before widening compatibility claims.

## Scope / limitations

- Initial host: Herdr; Unix sockets mean no Windows support yet. Host launching is isolated in `src/herdr.mjs` for future adapters.
- This clones conversation history and selected settings, **not running tools, subprocesses, live extension objects, temporary permissions, arbitrary CLI-only extensions, or filesystem state**. Child starts with its normal Pi resources plus this extension.
- Existing model definitions/auth must be available to the child. A source-only custom provider loaded through a transient CLI extension may need configuring for both sessions.
- If launch times out after a tab may have opened, inspect the retained clone path and existing tabs. Do not blindly create another.
- The saved clone is authoritative recovery material. Context import is not a semantic conflict resolver: original and clone may reach incompatible conclusions.

## Prior art

The concept already exists in useful forms:

- [@pi-kaush/pi-split-session](https://www.npmjs.com/package/@pi-kaush/pi-split-session): Herdr/Ghostty side session with handoff import.
- [pi-terminal-branch](https://github.com/vadimtrifonov/pi-terminal-branch): terminal pane/tab/window branches.
- [pi-session-merge](https://pi.dev/packages/pi-session-merge): conversation summary imports.

This implementation reuses **Pi's native session API**, not their source code. Its focus is explicit pre-task snapshots, clone naming, external busy-safe control, native Herdr menu integration, and durable noninterrupting merge-back. Those projects are worth trying if their existing workflow meets your needs.

MIT licensed. Do not publish as production-ready before testing the actual Herdr integration and reviewing the recovery paths.
