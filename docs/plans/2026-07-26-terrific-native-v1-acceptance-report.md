# Terrific native v1 acceptance report

Date: 2026-07-26
Target: Pi `0.81.1`
Profile: `terrific-native-v1`
Status: all automated Teams A-F requirements complete. Independent final review returned `SPEC_COMPLIANT: YES` and `QUALITY_APPROVED: YES`. Live rollout and publication were not authorized or performed.

## Teams A-F requirement map

| Team | Requirement | Direct artifacts | Fresh automated evidence |
|---|---|---|---|
| A | Public theme/header/editor/shortcuts; native input; responsive lifecycle | `extensions/appearance/**`, `themes/terrific-night.json` | `typecheck` + 71 tests; 40/80/120/160 x 16/20/24; truecolor/256 loader; generation-cached profile; 10 lifecycle generations |
| B | User/tool presentation only; exactly two controlled patches; native expansion | `extensions/presentation/**` | `npm --prefix extensions/presentation run check`: 91 tests; exact user/tool targets, OSC/Markdown, tool states, fail-open, CAS/timer lifecycle |
| C | One footer owner; frozen Terrific zones; real state/timers | `extensions/statusline/**` | `npm --prefix extensions/statusline test`: 179 tests; single/stacked inactive behavior, 40/80/120/160, 133/250 ms timer and stale-owner gates |
| D | Task HUD owner; unchanged process contracts; bounded active/inactive render | `extensions/taskboard/**` | Pi 0.81.1 dev peers; `run check`: 99 tests; inactive golden, statuses/telemetry, receipt suppression, 1 s timer and 10 generations |
| E | Mode/BTW first-party menus and overlay without semantic drift | `extensions/mode/**`, `extensions/btw/**` | Pi 0.81.1 dev peers; mode 20 tests, BTW 33 tests; Kitty/Unicode/filter/back/close; unchanged tools and isolated BTW session |
| F | Package order, docs/examples, archive/install, owner audit, PTY, rollback | root docs/examples, `scripts/{pack,test-install,audit-ui-owners}.sh`, fixture tree | archive/install smoke; target owner audit; active and inactive PTY matrices; exact backup restore; owner/resource/static scans |

## Frozen contract evidence

- All six consumers accept only exact global `appearance.profile: "terrific-native-v1"`; project-local activation is ignored and malformed input fails closed. Pi 0.81.1 TEMP-HOME runs the frozen eight-vector matrix across all parsers.
- Appearance reads the profile once per extension generation. A TDD regression proves file changes do not affect `/new`/resume lifecycle starts until a new generation (`/reload` or restart).
- Appearance is the only first-party `setHeader`/`setEditorComponent` caller; statusline is the only `setFooter` caller. Appearance has no status key. Widget keys remain package-owned.
- Presentation installs exactly `UserMessageComponent.prototype.render` and `ToolExecutionComponent.prototype.render`; no third prototype target, assistant/thinking patch, root transcript replacement, host fork, RPC frontend, or fullscreen overlay was added.
- `process_update`, `process-view-state-v1`, `process-view-context`, `/process`, and legacy `processView` reads remain the documented compatibility boundary. New package/config/status/widget identity is `taskboard`.
- No package imports a shared runtime appearance library and no new runtime dependency was added. `taskboard`, `mode`, and `btw` full gates now run against Pi peers `0.81.1`.

## Fresh command log

| Command | Result |
|---|---|
| `npm --prefix extensions/appearance run typecheck && npm --prefix extensions/appearance test` | Pass, 71 tests |
| `npm --prefix extensions/presentation run check` | Pass, 91 tests |
| `npm --prefix extensions/statusline test` | Pass, 179 tests |
| `npm --prefix extensions/taskboard run check` | Pass, 99 tests on Pi 0.81.1 peers |
| `npm --prefix extensions/mode run check` | Pass, 20 tests on Pi 0.81.1 peers |
| `npm --prefix extensions/btw run check` | Pass, 33 tests on Pi 0.81.1 peers |
| `SCANNER_SELF_TEST_ONLY=1 ./scripts/test-install.sh` | Pass: `detections=15 allowances=3`, including exact-token-only fixture exception |
| `AUDIT_UI_OWNERS_SELF_TEST_ONLY=1 ./scripts/audit-ui-owners.sh` | Pass: AST positives 22, negatives 9, enabled/disabled classification 1/1, missing/outside/no-manifest/no-production enabled roots rejected (4 total) |
| `AUDIT_UI_OWNERS_SETTINGS="$PWD/agent/settings.packages.example.json" ./scripts/audit-ui-owners.sh` | Pass: 223 manifests, 14,508 sources, 2 available owners, 2 target external roots, `enabled_owners=0` |
| `./scripts/test-install.sh` | Pass: 422 regular payloads, 418 UTF-8 text payloads, one auth template, Pilot 91 tests, loader 10/10, parser vectors, rollback, proposed owner audit |
| `capture.sh <temp-output>` | Pass: four active matrix points and generated hashes |
| `capture.sh --inactive-compare <temp-output>` | Pass: profile-off 80/120/160 baseline/target plain and ANSI equality |
| `bash -n scripts/*.sh capture.sh`; `git diff --check`; JSON/LF/final-newline checks | Pass |
| README installable-package table vs disk; package manifest resources | Pass, 12 installable packages |
| First-party setter/prototype static allowlist | Pass |
| Active and inactive committed `SHA256SUMS` | Pass, 12 active artifacts and 15 inactive evidence entries |

## Performance

Every benchmark uses 30 samples at 160 columns and enforces nearest-rank p95 `<16 ms`. Statusline also records 80/120 columns. Appearance/presentation time individual renders; the other packages use 100-render batches and report per-render time.

| Surface | Fresh p95 |
|---|---:|
| Appearance header / editor / shortcuts | `0.122 / 0.222 / 0.169 ms` |
| Presentation alternating user/tool | `0.888 ms` |
| Statusline 80 / 120 / 160 | `0.172 / 0.131 / 0.165 ms` |
| Taskboard | `0.530 ms` |
| Mode menu | `0.666 ms` |
| BTW menu / overlay | `0.738 / 1.025 ms` |

## Active PTY evidence

`docs/plans/fixtures/terrific-native-v1/capture.sh` builds and installs a temporary archive, pins repository-local Pi 0.81.1, and runs offline with isolated HOME/agent/session state. It passes:

- `80x24`, `120x40`, `160x50` truecolor and `120x40` 256-color.
- Startup, `Ctrl+O`, `/new`, filtered seed `/resume`, one-draft `Ctrl+C`, ten sequential `/reload`, and normal `/quit`.
- One header, shortcuts widget, footer, six extension resources, and one theme after reload; no runtime error markers.
- Same-PTY exact `stty -g` restoration, cursor-show and bracketed-paste-disable bytes, and post-exit shell input.
- Nonblank PNG, ANSI/plain semantics, path sanitization, and shell-safe `tmux pipe-pane` quoting. A full run under an apostrophe-containing `TMPDIR` also passes.

Committed active evidence and hashes are under `docs/plans/fixtures/terrific-native-v1/`.

## Profile-off comparison

`capture.sh --inactive-compare` compares two real archive-installed TUI processes at 80x24, 120x40, and 160x50:

- Baseline: `taskboard,presentation,statusline,mode,btw`.
- Target: the identical config plus `appearance`.
- Both: builtin `dark`, profile `off`, single statusline, no padding overrides, identical deterministic widget list.

Normalization removes only appearance-owned extension/theme discovery entries, isolated paths/session UUIDs, and outer blank lines. It does not normalize duration or other displayed UI. Plain and ANSI surfaces are byte-equal; target has no Terrific header, appearance shortcuts, or custom editor. Evidence and independent hashes are under `fixtures/terrific-native-v1/inactive/`.

## Owner decision and rollout preflight

The native profile chooses the complete Terrific editor. `pi-vision-handoff@0.8.1` has an optional `PrewarmEditor` for the same slot, so it is deliberately absent from `agent/settings.packages.example.json`. The target audit reports Vision and disabled compact-transcript as installed but non-enabled owners and passes with `enabled_owners=0`.

The unchanged current live settings still enable Vision and do not enable appearance. Running `./scripts/audit-ui-owners.sh` against live therefore reports one enabled third-party owner. This is expected pre-rollout evidence, not a target-profile pass: rollout must first apply the proposed single-owner package set, then rerun the audit. Package order is not used to hide the conflict, no third-party source was changed, and no silent allowlist was added.

## Archive, rollback, and integrity

The archive gate byte-scans every regular member, including NUL/non-UTF-8 payloads, for concrete repo/HOME paths and credential markers. It validates every JSON credential field, requires exactly one valid recursively empty `snapshot/agent/auth.template.json`, and permits only one exact fake test token at its exact known fixture path.

TEMP-HOME rollback creates a five-package/dark/profile-off native baseline, saves present files and SHA256SUMS, records an absent statusline file, activates the six-package profile, then restores originals and deletes ABSENT_FILES. Exact original hashes/absence and a fresh five-package/no-theme/default-padding/inactive-parser loader are verified.

`integrity-baseline.sha256` still matches all six snapshot files, `scripts/install.sh`, and the three filename-only live config hashes. `snapshot/agent/settings.json` remains dirty relative to HEAD from pre-existing Pilot work but is byte-identical to Team F start. No live write, snapshot refresh, stage, commit, push, or dist publication occurred.

## TDD and reviews

Recorded RED-to-GREEN cases include manifest order, archive path/secret detection, apostrophe pipe quoting, hard-wrapped resource checks, appearance generation caching, target third-party owner selection, owner-provenance/root fail-closed checks, and strict profile-off comparison. Teams A-E previously received independent package spec and quality approval. Final full-plan review returned `SPEC_COMPLIANT: YES`; final delta review returned `QUALITY_APPROVED: YES`.

## Manual-only

The remaining non-automatable evidence is:

1. Windows Terminal and VS Code terminal font/color/layout feel at target dimensions and color modes.
2. Authorized model-driven working, tool-error, edit-receipt, blocked-task, and BTW answer/copy/retry/editor flows, including subjective visual inspection of expanded tool rows.

These are not marked passed. Rollout, snapshot refresh, packaging for distribution, commit, and push remain separate explicit authorization checkpoints.
