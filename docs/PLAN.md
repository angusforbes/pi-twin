# Live clone — implementation contract

Requested by Angus, 2026-09-21. Development in a standalone Pi package, with a small optional Herdr adapter. Do not replace Pi's built-in `/clone` or restart the shared Herdr server without approval.

## User experience

- Clone through a Herdr tab context-menu action, including while the source is working. A slash-command/CLI entry point supports development and other integrations.
- Original remains alive and untouched. Independent clone opens in a new tab, focused and waiting for a prompt.
- Idle: copy active branch at current leaf. Busy: copy at the checkpoint immediately before the prompt that initiated the current task. Do not import streaming partial responses or trigger/replay that task.
- Inherit current provider/model and effective thinking effort even if these differ from settings recorded at the historical checkpoint. Same cwd and normal Pi resources. This is conversation cloning, not cloning a live process or a filesystem snapshot.
- Names: Sift_clone1, Sift_clone2, etc. Preserve durable source-session identity and branch boundary, independently of display names/pane moves.
- Shared-files warning, no forced sandbox/worktree. No claims of file isolation.
- Merge back: editable, clearly attributed handoff since divergence; optional transcript. Never splice raw tool-call/assistant entries into a running original. Background-information default; explicitly opt into asking the original to act.
- If parent busy, durable pending merge delivered only after full settle; no interruption. Acknowledgments distinguish queued from actually imported. Retry idempotently.
- Retain saved sessions. Optional close only after confirmed import, never on a request timeout. Source still running and files unchanged by merge.

## Engineering boundaries

- Community-shareable package manifest, README, license decision, tests, no personal paths/credentials in tracked files.
- Host adapter separate from Pi session cloning/lineage/merge logic. Initial host Herdr; no universal-terminal claims.
- Capability-scoped local IPC, private runtime directory, bounded requests, target session identity checks, cleanup on shutdown/reload. Never inject keystrokes into a busy Pi editor.
- Do not switch/fork the source's active SessionManager. Clone with an independent manager/snapshot using supported session APIs and test against installed Pi.
- Original agent lifecycle hooks identify a safe pre-run snapshot. Preserve checkpoint across retries and auto-compaction; fail closed when exact checkpoint cannot be established.
- No hidden model calls for cloning. A merge summary must be explicit (user-entered/edited or generated on request); no silent transcript truncation.
- Validate multi-clone races, queued merge + restart, repeated delivery, cancellation, failures before/after tab launch, nested clones, renamed/replaced parent sessions, first-message and compacted sessions.

## Existing community work found

- `@pi-kaush/pi-split-session`: Herdr/Ghostty side pane, `/split`, handoff generation/import, explicit full transcript. Investigate reuse before copying any implementation; preserve license/attribution if code is reused.
- `vadimtrifonov/pi-terminal-branch`: clone/fork in another terminal pane/tab/window.
- `pi-session-merge`: summary-based session import.

These establish that the general concept already exists. Differentiators to verify: busy-source pre-task checkpoint, tab context menu, clone names, durable noninterrupting merge delivery.
