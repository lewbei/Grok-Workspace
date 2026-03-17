# Verification Status

This file is the current evidence ledger for the Grok app surfaces. It records what has been confirmed, what is still unconfirmed, and where release signoff should point.

Last updated: 2026-03-17

## Confirmed

### App startup and local state

- App loads with a valid `.env` and reports `GROK_API_KEY loaded`
- Missing proxy connection surfaces a clear local-server error
- Corrupted or stale browser `localStorage` does not crash the app
- Theme persists across reload
- `Clear local chats` works from Settings

### Threads and multi-turn behavior

- New thread creation works
- Delete active thread works
- Delete-only-thread fallback creates a fresh usable thread
- Standard -> standard follow-up works
- Standard -> agent follow-up works
- Agent -> standard follow-up no longer hard-fails
- Agent -> standard now resets to fresh model context with a warning
- Thread title is derived from the first meaningful prompt
- Lost continuation token clears broken `lastResponseId` and surfaces a warning
- When server continuation is lost, the next web send replays local thread history to recover context

### Modes, tools, and routing

- Standard non-reasoning mode works
- Standard reasoning mode works
- Agent mode `4` works
- Agent mode `16` works
- Tool toggles remain visible in both Standard and Agent mode
- Agent mode changes model/depth only; tool selection remains active
- Standard `Web` works and emits tool traces
- Standard `Code` works and emits tool traces
- Standard `X` works and now emits tool traces
- Agent `Web` works and emits tool traces
- Agent `Code` works and emits tool traces
- Tool counts in usage are driven by xAI `server_side_tool_usage_details`

### Transcript and UI behavior

- User message appears immediately on send
- Assistant placeholder appears immediately on send
- Streaming text updates appear live in the transcript
- Transcript auto-scrolls during streaming
- Tool trace rows render during execution
- Agent mode shows a single progress row
- Usage and cost cards appear after completion
- Message text size was reduced for denser transcript display
- Bottom-left Settings button is present in the sidebar
- Website mode labels now present as `Chat` and `Deep Research`
- Composer usage summary is cumulative at the thread level by default

### Attachments

- Supported text/code attachments are accepted
- Unsupported attachment extensions are rejected in-browser
- Oversized attachments above `1 MB` are rejected in-browser
- Invalid UTF-8 text attachments show a clear browser error
- Duplicate attachment names are deduplicated in draft state

### Shortcuts

- `Ctrl+Enter` sends
- `Ctrl+N` creates a new thread
- `Ctrl+,` opens Settings
- `Ctrl+Shift+A` toggles Agent mode
- `Ctrl+Shift+R` toggles reasoning in Standard mode
- `Ctrl+L` focuses the composer
- `Esc` closes Settings or dismisses the current banner

### Error normalization and tests

- Invalid API key is normalized to `invalid_api_key`
- Invalid `previousResponseId` is normalized to `invalid_previous_response_id`
- Policy-blocked requests are normalized to `policy_blocked`
- Malformed local stream data is normalized to `malformed_stream`
- `429` is covered by regression tests as `rate_limited`
- `5xx` is covered by regression tests as `upstream_unavailable`
- Current automated checks pass:
  - `npm test`
  - `npm run build`
  - `cargo test`
  - `npm run tauri build -- --debug`

### Desktop shell and persistence

- Tauri desktop now uses the Codex-like shell as its primary UI
- Desktop projects and threads are persisted through the Tauri backend instead of browser `localStorage`
- Desktop settings can save the xAI API key into the Windows credential store
- Desktop file attachments use the native file picker and are uploaded from real filesystem paths
- Desktop agent mode now keeps built-in tools enabled just like the web shell
- Desktop installers were produced successfully:
  - `src-tauri/target/debug/bundle/msi/Grok Control_0.1.0_x64_en-US.msi`
  - `src-tauri/target/debug/bundle/nsis/Grok Control_0.1.0_x64-setup.exe`

### Settings and trust UX

- Settings is exposed as a real dialog surface with dialog semantics
- Keyboard focus is trapped within Settings while it is open
- Focus returns to the previous control when Settings closes
- Local workspace reset now requires explicit confirmation

## Not Fully Verified Yet

### Live upstream failures

- A real xAI-generated `429` has not been observed live end-to-end
- A real xAI-generated `5xx` has not been observed live end-to-end

### X-specific upstream variability

- `X` tool tracing is fixed in the app and works on successful prompts
- Some `X` prompts can still be blocked upstream by xAI policy depending on prompt/account behavior
- Agent-mode `X` has previously hit a live `403 policy_blocked`, so this path should be treated as upstream-variable rather than fully guaranteed

## Known Product Gaps

- No queued prompt execution
- No batch prompt submission
- No resume flow after a cancelled run
- No cloud sync or user accounts
- Desktop debug failure harness is not yet at parity with the web debug proxy
- Native desktop menu/window-restore polish is not fully signed off yet

## Recommended Next Checks

- Capture a real upstream `429` if possible
- Capture a real upstream `5xx` if possible
- Re-run a small agent-mode `X` prompt set after any future server or model-routing changes

## Release Gate Links

- UX parity: [docs/release-ux-parity.md](C:/Users/lewka/deep_learning/grok/docs/release-ux-parity.md)
- Runtime parity: [docs/release-runtime-parity.md](C:/Users/lewka/deep_learning/grok/docs/release-runtime-parity.md)
- Desktop readiness: [docs/release-desktop-readiness.md](C:/Users/lewka/deep_learning/grok/docs/release-desktop-readiness.md)
