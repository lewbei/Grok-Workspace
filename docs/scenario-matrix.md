# Scenario Matrix

This matrix is the runtime acceptance artifact for the current Grok Web product. It documents the intended behavior, the scenarios that must be exercised, and the evidence fields that should be recorded during release validation.

## Product Model

- Single prompt means one send in a thread.
- Multiple prompt means follow-up turns inside the same saved thread.
- Mode, reasoning, depth, tools, and attachments are per-message controls.
- Thread history is stored in browser `localStorage`.
- Follow-up requests use the latest successful `previousResponseId` when available.
- Known xAI limitation surfaced in-product: switching from `Agent mode` back to `Standard chat` starts a fresh model context for that turn instead of reusing the prior agent continuation chain.

## Core Scenarios

### Bootstrap and lifecycle

- First run with valid `.env`
- Missing `GROK_API_KEY`
- Local proxy reachable vs unreachable
- Reload with existing saved threads
- Reload with corrupted or stale local thread storage

### Single-prompt baseline

- Standard non-reasoning with no tools
- Standard reasoning with no tools
- Agent `4` with no tools
- Agent `16` with no tools
- Prompt only
- Attachment only
- Prompt plus attachments
- Empty prompt with no attachments blocked locally

### Multi-turn thread behavior

- Standard -> standard
- Standard -> agent
- Agent -> standard
- Agent `4` -> agent `16`
- Tools changed between turns
- Attachments changed between turns
- Follow-up after reload
- Follow-up after lost `previousResponseId`
- Lost continuation replays local thread history on the next web send

### Tool execution

- Tool selected and invoked
- Tool selected but not invoked
- Tool selected and rejected upstream
- Standard `Web`
- Standard `Code`
- Standard `X`
- Agent `Web`
- Agent `Code`
- Agent `X`
- Usage totals driven by xAI `server_side_tool_usage_details`

### Streaming and transcript UX

- User message appears immediately
- Assistant placeholder appears immediately
- Partial assistant text streams before completion
- Transcript auto-scrolls during streaming
- Tool trace renders during execution
- Agent mode shows a single progress row
- Usage/cost card appears after completion
- Composer usage summary reflects cumulative thread totals by default

### Attachments

- Supported text/code extension accepted
- Unsupported extension rejected with a clear error
- Oversized file rejected with a clear error
- Duplicate file names are deduplicated in draft state
- Attachment removed before send

### Persistence and recovery

- New thread creation
- Delete active thread
- Delete only thread
- Clear local chats from Settings
- Theme persists after reload
- Thread title derived from first meaningful prompt
- Lost continuation token surfaces a warning and clears broken `lastResponseId`
- Settings opens as a keyboard-trapped dialog and returns focus on close
- Local workspace reset requires explicit confirmation

### Failure handling

- xAI `401`
- xAI `429`
- xAI `5xx`
- Policy-blocked tool request
- Local proxy unreachable
- Incomplete or malformed storage state
- Missing tool stream events with valid final usage totals

## Acceptance Recording Template

Each validation row should record:

- Prompt text
- Mode and controls used
- Expected transcript badges
- Expected streaming behavior
- Expected tool trace behavior
- Expected usage/cost behavior
- Expected saved-thread behavior after reload

## Required Live Validations

- Standard `Web` invokes and reports tool usage
- Standard `Code` invokes and reports tool usage
- Agent `Web` invokes and reports tool usage
- Agent `Code` invokes and reports tool usage
- `X` either invokes successfully or surfaces the upstream rejection clearly
- Multi-turn follow-up preserves per-message badges instead of thread-wide defaults
- Lost continuation token shows a warning and prevents repeated invalid follow-up failures

## Release Evidence Pointers

- Current checked vs unchecked state: [docs/verification-status.md](C:/Users/lewka/deep_learning/grok/docs/verification-status.md)
- UX gate: [docs/release-ux-parity.md](C:/Users/lewka/deep_learning/grok/docs/release-ux-parity.md)
- Runtime gate: [docs/release-runtime-parity.md](C:/Users/lewka/deep_learning/grok/docs/release-runtime-parity.md)
- Desktop gate: [docs/release-desktop-readiness.md](C:/Users/lewka/deep_learning/grok/docs/release-desktop-readiness.md)

## Known Non-Goals

- No queued prompt execution
- No batch prompt submission
- No cancel/resume in the current web UI
- No cloud sync or user accounts
