# Release Checklist: Runtime Parity

Use this checklist before calling the conversation runtime "release-ready."

Status key:
- `PASS` validated and accepted
- `FAIL` known missing or broken
- `UNKNOWN` not yet checked

## Core Request Flows

- `PASS` Standard non-reasoning requests work
- `PASS` Standard reasoning requests work
- `PASS` Agent `4` requests work
- `PASS` Agent `16` requests work
- `PASS` Tool selection works in both Standard and Agent mode
- `PASS` Standard `Web` works
- `PASS` Standard `Code` works
- `PASS` Standard `X` works on successful prompts
- `PASS` Agent `Web` works
- `PASS` Agent `Code` works
- `UNKNOWN` Agent `X` is reliable across a representative prompt suite

## Multi-turn Continuation

- `PASS` Standard -> standard works
- `PASS` Standard -> agent works
- `PASS` Agent -> standard falls back cleanly with a warning
- `PASS` Lost continuation clears the broken token and surfaces a warning
- `UNKNOWN` Long mixed threads have been exercised with no state leakage

## Runtime Controls

- `FAIL` Stop during streaming exists and works
- `FAIL` Retry after error/completion exists and works
- `FAIL` Reconnect/resume states are explicit when the proxy or stream drops
- `PASS` Tool traces appear during execution
- `PASS` Agent progress appears during multi-agent runs

## Failure Handling

- `PASS` Invalid API key is normalized clearly
- `PASS` Invalid continuation is normalized clearly
- `PASS` Policy blocks are normalized clearly
- `PASS` Malformed local stream data is normalized clearly
- `UNKNOWN` A real upstream `429` has been observed through the UI
- `UNKNOWN` A real upstream `5xx` has been observed through the UI

## Signoff

- Runtime owner:
- Date:
- Notes:
