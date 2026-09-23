# Optional Herdr menu integration

`agent-split.patch` preserves the optional native Herdr tab-menu implementation against local integration base `bf07fc3`. That base contains custom integrations; this is NOT claimed to apply to stock upstream Herdr.

The extension commands work without this patch. With it, eligible single-pane tabs expose **Agent Split**, and split children additionally expose **Agent Merge**. The helper CLI must be on the server's PATH. Actions capture/revalidate the session identity and invoke the CLI without a shell. Both interactive and headless-server event loops dispatch actions.

Before installation, review the patch against your actual Herdr checkout, back up the existing binary, build successfully, and follow Herdr's supported live-handoff procedure. Do not stop a shared server to install it. Existing Pi sessions need `/reload` after installing/updating the extension.

Verification on the implementation base: full Linux Rust suite passed before the final small follow-up changes; subsequent targeted input, launcher, and headless-dispatch tests and release builds passed. Windows verification was blocked by an unavailable rustup toolchain. Real Pi/Herdr split tests and user-operated menu/twin-merge checks passed. This is a locally tested integration patch, not an upstream release or accepted upstream contribution.

A local machine's separate tab-name synchronization helpers must preserve trailing square brackets. A punctuation-stripping helper can turn `Thumper[a]` into `Thumper[a` even when the extension publishes the correct name. This is outside the extension and menu patch.
