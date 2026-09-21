# Review and verification notes

## Scope

Experimental implementation tested against Pi 0.85.1. Do not equate mocked host tests with native Herdr mouse-menu verification. No shared Herdr deployment or npm publication is implied.

## Independent lifecycle review

An Anthropic reviewer examined the OpenAI-produced snapshot/controller/extension/host/CLI code. The parent separately inspected the Anthropic-produced transport and requested startup-race, UTF-8, byte-limit, and private-directory corrections.

Adjudication of lifecycle findings:

- **Session change during handoff dialogs or IPC awaits:** accepted. Generation is checked before sending and after acknowledgment; closure is guarded again after its confirmation dialog and requires idle. A replacement session must never be closed because an old clone's dialog completed.
- **Lifecycle event errors:** improved. Pi itself catches extension event failures, so these were not unhandled process exceptions as claimed; the wrapper now additionally gives explicit actionable notices while preserving pending handoffs.
- **Idempotent clone returning an in-progress record:** the claimed second-launch crash was not reproduced by the code path. Creation is synchronous before the first await; repeated IDs return the existing status and do not call the launcher again. A crash can leave `creating`/`prepared` records. These must NOT be automatically retried as fresh launches; the CLI now exits nonzero for states other than confirmed `launched`, retains the request ID, and exposes records through status for recovery.
- **Synchronous Pi custom-message append:** verified directly in Pi 0.85.1 implementation and the two-process runtime smoke test when idle with `triggerTurn:false`. The implementation fails closed if it cannot confirm the history append. Do not widen Pi compatibility without rerunning this test. Receipt means imported context, not completed optional follow-up work.
- **Permanent clone-name reservations:** intentional, to avoid name reuse after restart/archival. These are allocated only on explicit clone requests. No automatic cleanup that could reuse a still-referenced clone name is installed.

## Tests

`npm run check` runs TypeScript checks and deterministic tests of Pi-native session extraction, model/effort inheritance, no source mutation, first-message and compacted sessions, tool-batch guards, names, mailbox recovery, lineage, duplicates, failed launch, host argv, and IPC.

`npm run test:rpc` starts two actual Pi processes with isolated configuration, a local HTTP mock model, and mocked Herdr CLI. It holds the original's response open while cloning; starts the saved child independently; completes a tangent; submits its background handoff while the original remains working; verifies import after full settle; tests duplicate submission and interactive editor/selection flow. Only the two explicitly requested model turns occur.

## Remaining acceptance work

- Native patched Herdr tab-menu behavior and actual tab/process launch should be exercised on a disposable workspace before deployment to a shared server.
- Test other Pi versions and macOS before claiming support beyond the tested Linux/Pi combination.
- A confirmed handoff receipt confirms context import. It is not proof that optional requested follow-up work ran or survived a process crash immediately after import; the original can always be asked to act on the preserved handoff.

## Native host acceptance

The real Herdr launcher test initially exposed a mismatch mocks could not: Herdr runtime agent aliases must be lowercase ASCII and at most 32 characters. Human-facing `Sift_clone1` cannot be passed directly as that alias. The adapter now uses a short `lc-<UUID>` runtime alias and publishes the actual Pi/tab/sidebar name separately. It also propagates a narrow allowlist of configuration/state directories, never provider credentials or source session IDs.

`node tests/native-herdr-smoke.mjs --run` then passed against the installed Herdr server: two real Pi processes in separate tabs, original still responsive, child waiting for input with correct saved/current identity, model, effort, cwd and display token. Test tabs were closed and previous focus restored. No server restart or model call occurred. Separate native tab-menu clicking remains to be tested on the candidate Herdr build.

A further parent transport review rejected PID-based startup-lock theft: an empty lock can be a live writer between open/write, and simultaneous stale-lock reapers can unlink a new owner's claim. Startup claims now fail closed with an explicit recovery path rather than guessing. Regression tests cover empty claims, directory privacy, malformed response envelopes, and Unicode transport.
