# Terrific native v1 evidence fixtures

Target runtime: `@earendil-works/pi-coding-agent` `0.81.1`.

## Actual PTY captures

Each matrix point has a sanitized ANSI capture (`.ansi`), direct tmux plain capture (`.txt`), and ImageMagick text-layout preview (`.png`):

- `80x24-truecolor.*`
- `120x40-truecolor.*`
- `160x50-truecolor.*`
- `120x40-256color.*`

Committed hashes are in `SHA256SUMS`:

```bash
(cd docs/plans/fixtures/terrific-native-v1 && sha256sum -c SHA256SUMS)
```

Reproduce into a fresh temporary directory without replacing committed fixtures:

```bash
rm -rf /tmp/terrific-native-v1-capture-check
docs/plans/fixtures/terrific-native-v1/capture.sh /tmp/terrific-native-v1-capture-check
(cd /tmp/terrific-native-v1-capture-check && sha256sum -c SHA256SUMS)
```

Exercise the `tmux pipe-pane` quoting path with an apostrophe in `TMPDIR`:

```bash
quoted_tmp=$(mktemp -d "/tmp/terrific-native-quote'XXXXXX")
TMPDIR="$quoted_tmp" docs/plans/fixtures/terrific-native-v1/capture.sh "$quoted_tmp/output"
(cd "$quoted_tmp/output" && sha256sum -c SHA256SUMS)
```

## Profile-inactive comparison

Committed inactive evidence is reproduced independently from the active matrix:

```bash
rm -rf /tmp/terrific-native-v1-inactive-check
docs/plans/fixtures/terrific-native-v1/capture.sh --inactive-compare /tmp/terrific-native-v1-inactive-check
(cd /tmp/terrific-native-v1-inactive-check && sha256sum -c SHA256SUMS)
```

For each of `80x24`, `120x40`, and `160x50`, the mode starts two real tmux TUI processes from one temporary archive install under the same isolated `HOME`, offline environment, dimensions, session policy, builtin `dark` theme, inactive `appearance.profile`, and `single` statusline. The comparison uses the same explicit baseline widget list on both sides with only the wall-clock `duration` widget disabled, so no displayed duration is normalized or ignored. The baseline loads `taskboard`, `presentation`, `statusline`, `mode`, and `btw`; the target changes only the package list by adding `appearance`. Neither settings file contains `editorPaddingX` nor `outputPad`.

Each process captures the complete current viewport as sanitized plain and ANSI text with the same editor draft, then clears the draft and exits normally through `/quit`. The target is rejected if it contains the Terrific header, appearance shortcuts row, or custom editor border. Byte-equal normalized ANSI against the builtin-dark baseline is the runtime theme-inactivity check. Every width has baseline/target artifacts and a comparison manifest recording equal hashes; `inactive/SHA256SUMS` covers those files.

Normalization is deliberately narrow: within the named `[Extensions]` and appearance-only `[Themes]` discovery bands it removes only `appearance.ts` and `terrific-night` resource discovery plus the band's resulting whitespace. Outside resource discovery it removes the wrapper's exact startup-gate marker, replaces isolated repository/agent/project paths and session UUIDs while preserving ANSI controls, and trims only outer blank lines. Header, intro/body, editor draft and borders, widgets, footer, durations, and all other non-empty lines remain byte-for-byte comparison inputs. A focused unified diff is printed and the run fails on any remaining plain or ANSI difference. Output directories must be absent or empty and are never overwritten.

`capture.sh` requires an explicit empty output directory, refuses the committed fixture directory and non-empty destinations, verifies repository-local Pi is exactly `0.81.1`, and never uses a global Pi installation. It builds and installs a temporary archive under isolated `HOME`/`PI_CODING_AGENT_DIR`, runs with `PI_OFFLINE=1`, and deletes temporary installs, per-point sessions, raw PTY pipes, and the tmux server on exit.

Every matrix artifact contains seven labeled frames from one PTY lifecycle:

1. startup of a named seed session;
2. resource expansion after `Ctrl+O`;
3. `/new` after `New session started`;
4. `/resume`, seed-name filtering/selection, and `Resumed session`;
5. one `Ctrl+C` after typing a distinctive editor draft, with the draft cleared and Pi still alive;
6. the settled result after ten sequential `/reload` operations;
7. normal `/quit` into the wrapper shell with terminal restoration markers and successful shell input echo.

The reload gate records a stable raw-output baseline before each command and requires the visible completion-marker count to increase after every operation. After ten operations it requires a live pane, one Terrific header, one shortcuts widget, one footer, one occurrence of every expanded extension/theme resource, and no runtime error marker. Existing package-specific ten-generation lifecycle tests remain supporting cleanup evidence; this combined PTY is the actual Pi runtime owner-cleanup evidence.

The wrapper shell records `stty -g` before Pi and after normal `/quit` in the same PTY and requires byte-exact equality. A raw `tmux pipe-pane` is attached behind a start gate before Pi starts; after exit the harness requires cursor-show (`ESC[?25h`) and bracketed-paste-disable (`ESC[?2004l`) sequences, then sends and reads a distinctive shell line. Pi is not killed on the evidence path; tmux termination is cleanup fallback only.

The temporary settings load exactly `taskboard`, `presentation`, `appearance`, `statusline`, `mode`, and `btw`; select `terrific-night`; and set the frozen profile/layout/padding values. No credential, network access, global write, raw pipe, or session JSONL is included in the fixture directory. Repository and temporary absolute paths are replaced with `<REPO>` and `<PTY_TMP>`.

The harness asserts exact pane dimensions, truecolor/256-color ANSI behavior, path sanitization, semantic markers, and nonblank PNG pixels. PNGs are 8-bit grayscale text-layout previews, not color-fidelity evidence; the ANSI files distinguish color modes. Each run writes its own hashes, so reproducible semantics and provenance are claimed, not byte-identical timestamps/session IDs across runs.

## Integration and rollback evidence

`./scripts/test-install.sh` loads the six archive-installed sources with Pi 0.81.1 `DefaultResourceLoader` for ten consecutive reload cycles. Every cycle asserts exact extension order, zero diagnostics, one `terrific-night` theme, and unique extension/theme resource paths.

Before activation, the same smoke creates a representative TEMP-HOME native baseline with five packages, builtin `dark`, profile `off`, default padding fields absent, and `statusline.json` absent. It persists the two present files plus `SHA256SUMS`, records `statusline.json` in `ABSENT_FILES`, then applies the six-package active profile. After the active gates, restore copies the backup files and deletes the recorded absent file; exact original hashes and absence are checked before a fresh settings manager/loader asserts five extensions, no custom Terrific theme, default padding, and five inactive profile parsers.

## Owner audits

The archive integration audit proves the exact six-package target has only the approved first-party owners: appearance for header/editor, statusline for footer, taskboard/appearance for their widget keys, and presentation for the two controlled prototype patches.

The reproducible third-party scan is separate from the first-party archive audit:

```bash
AUDIT_UI_OWNERS_SELF_TEST_ONLY=1 ./scripts/audit-ui-owners.sh
AUDIT_UI_OWNERS_SETTINGS="$PWD/agent/settings.packages.example.json" ./scripts/audit-ui-owners.sh
./scripts/audit-ui-owners.sh  # current live pre-rollout warning surface
```

The scan counts 223 manifests and 14,508 TypeScript/JavaScript sources across installed npm/git trees. Its TypeScript AST finds two available production owners. The proposed native profile settings deliberately omit `pi-vision-handoff`, resolve two enabled external roots, and pass with `enabled_owners=0`; both Vision and disabled `pi-compact-transcript` are reported as installed but non-blocking for that target. The unchanged current live settings still enable `pi-vision-handoff@0.8.1` and therefore fail with one enabled owner, while appearance itself is not live-enabled. Rollout must apply the proposed single-owner choice before adding appearance, then rerun the proposed/live audit. The script is read-only, uses no network, fails closed when an enabled root is missing/outside the npm/git cache/lacks a manifest or production source, and self-tests exactly 22 direct/optional/bracket/cast/context/UI/destructuring/call-propagation/ESM/CJS-handler/import/prototype positives, 9 comment/string/unrelated/local-UI/local-component/wrong-import/shadowing negatives, enabled-vs-disabled classification, and 4 enabled-root rejection cases.

## Integrity evidence

`integrity-baseline.sha256` stores the six filename-relative `snapshot/agent` start hashes, `scripts/install.sh`, and sanitized filename-only live-config start hashes. `snapshot/agent/settings.json` was already dirty relative to HEAD before Team F; all recorded snapshot/install/live hashes remained unchanged.

## Manual-only evidence

Only Windows Terminal/VS Code actual visual feel and authorized model-driven working, error, edit receipt, blocked task, and BTW flows remain manual. Session lifecycle, `Ctrl+C`, ten reloads, terminal restoration, loader rollback, and owner scanning are automated and are not classified as manual evidence.
