# Task Plan: Delete skim annotations

## Goal
Add an iconic context-menu command that deletes all add-on-created annotations and migrate their tag prefix to `autoskim-`.

## Phases
- [completed] Inspect annotation creation, tag conventions, deletion APIs, and existing menu tests.
- [completed] Add `Delete skim annotations` menu item and deletion behavior.
- [completed] Change generated annotation tags to `autoskim-…`.
- [completed] Add unit tests for visibility, icon, command binding, and deletion behavior.
- [completed] Run full validation.
- [pending] Commit on request.

## Decisions
- Deletion targets annotations carrying the add-on tag prefix only.
