# Release Checklist: Desktop Readiness

Use this checklist before restoring Tauri as the primary delivery target.

Status key:
- `PASS` validated and accepted
- `FAIL` known missing or broken
- `UNKNOWN` not yet checked

## Preconditions

- `FAIL` UX parity checklist is signed off
- `FAIL` Runtime parity checklist is signed off
- `PASS` The web app is the current source of truth

## Desktop Shell

- `PASS` Native window shell has been reintroduced on top of the approved web UI
- `UNKNOWN` Native menu/app commands match the intended keyboard-first workflow
- `UNKNOWN` Window restore and app-state restore work consistently
- `PASS` Installer output and local launch flow have been validated after the desktop-shell migration

## Security and Persistence

- `PASS` Desktop key handling is wired through a secure local mechanism
- `PASS` Desktop persistence behavior is now backed by Tauri local storage
- `FAIL` Desktop-specific failure harness parity is not complete yet

## Release Packaging

- `PASS` Desktop build pipeline has been rerun after the desktop-shell migration
- `PASS` Installer artifacts were produced successfully on the target machine
- `UNKNOWN` Desktop release notes/checklist have been updated for the current feature set

## Signoff

- Desktop owner:
- Date:
- Notes:
  - Desktop now builds and bundles as `Grok Control`.
  - Current remaining desktop parity gaps are the debug failure harness, full native menu polish, and final UX/runtime signoff.
