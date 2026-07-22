# Presentation Phase 0 Compatibility

> Historical fork baseline only. As of 2026-07-22, `presentation` uses public Pi tool wrappers and no longer installs these renderer forks; retain this file for audit history only.

Date: 2026-07-21

## Verified

- Pi baseline: `0.80.10`.
- `pi-tool-display@0.5.0` installs in an isolated `PI_CODING_AGENT_DIR`; upstream baseline is `91cef7580078371f8dc49a8607222807ad6a424d`.
- `pi-compact-transcript@0.6.2` installs in an isolated `PI_CODING_AGENT_DIR`; upstream baseline is `abf969c69052cc69419a806fddc5b350ee7e57e0`.
- The required load order is `pi-tool-display` before `pi-compact-transcript`. Pi recognizes both local package paths in that order, and startup/model discovery completes without an extension-load error.
- `PI_CODING_AGENT_DIR` is Pi's isolation variable. `PI_HOME` is a repository script convention and does not isolate `pi install` itself.

## Phase 1 Local Validation

- The tool-display patch adds `enableThinkingLabels` and `decorateMcpTools`; both default to upstream-compatible `true` and can be disabled independently.
- The compact-transcript patch adds conditional multi-operation tool-turn summaries, turn-bounded bursts, consistent tool-block spacing, `process_update` preservation/exclusion, hidden thought-ticker control, shell-command privacy, workspace-relative path formatting, and reload restoration for both patched prototypes.
- `pi-tool-display`: `npm run check` passed, including 723 tests.
- `pi-compact-transcript`: `npm test` passed, including its three Phase 1 regression tests.

## Published Pins

- `git:git@github.com:Lcc1ccl/pi-tool-display@8dd8fcaa7a3307abac5ee05f735615d4eae394b1`
- `git:git@github.com:Lcc1ccl/pi-compact-transcript@1bad0d81c38ca0821710e466a8e76928bdc326ef`
- Both `terrific-pi/presentation` remote refs were verified with `git ls-remote`. The forks are currently private, so target machines need GitHub SSH access until their visibility changes.

## Historical Gate Resolution

- The former six authenticated model-backed TUI transcript fixtures and 80/120/160-column visual captures were completed after migration to public `presentation` wrappers. They are archived in [2026-07-22-live-model-verification.md](./2026-07-22-live-model-verification.md); this historical fork baseline is not the current runtime evidence.
