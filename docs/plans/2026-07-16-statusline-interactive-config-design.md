# Statusline Interactive Config Design

Date: 2026-07-16  
Scope: `extensions/statusline`

## Goal

Make `/statusline` an interactive TUI configuration console so users can fully configure the footer in-terminal without hand-editing JSON.

## Decisions

1. **UI approach:** Nested selectors plus small custom components for prefilled numeric input and widget editing (not a custom full-screen panel).
2. **Persistence:** Immediate apply — each successful change atomically writes `statusline.json` and refreshes the footer.
3. **Compatibility:** Keep `/statusline reload`. Non-TUI modes still print config text.

## Command behavior

### `/statusline` (TUI)

Enter a main-menu loop until the user chooses **Done** or cancels.

Main menu actions:

- Widgets (toggle + reorder)
- Layout
- Icon mode
- Widget separator
- Widget spacing
- Context mode
- Context bar width
- Minimal mode
- Show config
- Reload from file
- Reset to defaults
- Done

Header of the menu should summarize current config (widgets, contextMode, bar width, minimal, spacing with default/min/max, config path).

### `/statusline reload`

Reload config from disk and notify.

### Non-TUI

Print current config text (existing behavior). Do not attempt interactive dialogs.

## Submenus

### Widgets (toggle + reorder)

Single multi-select screen:

- List all known widget ids: enabled first (config order), then disabled (catalog order).
- `Space` toggles `[x]` / `[ ]`.
- Configured select up/down keys (or `j/k`) move the selection cursor.
- Configured cursor left/right keys (or `h/l`) swap the focused item with its neighbor (exact order in single layout; within-group order in stacked layout).
- Enter / Esc exits back to the main menu.
- Constraint: at least one widget must remain enabled.
- Boundary moves are no-ops.
- Each successful toggle/move applies immediately (footer + JSON).

### Context mode

Select `remaining` or `used`.

### Context bar width

Custom single-line `Input` initialized with `setValue(current)`.

- Valid: integer 4–40
- Invalid: error notify, no change

### Minimal mode

Select on/off.

### Widget separator and spacing

Separator is a selector immediately followed by the numeric spacing input.

- `separator`: `"dot"` (`·`) or `"bar"` (`│`); default `"dot"`
- separator changes only widget boundaries; related values inside a widget remain dot-separated
- `spacing`: integer `0`–`4` terminal cells on each side; default `1`

### Show / Reload / Reset / Done

- Show: multi-line notify of active config
- Reload: reread file into memory + refresh
- Reset: confirm, then write `DEFAULT_CONFIG` and refresh
- Done: exit loop

## Immediate apply pipeline

On each successful mutation:

1. Atomically `saveStatuslineConfig(configPath, config)`
2. Update in-memory `config`
3. `requestRender()` and synchronize config-dependent collectors
4. Short success notify

On save failure: error notify; do not keep the in-memory mutation (or roll back to previous snapshot).

## Persistence details

Add `saveStatuslineConfig(path, config)`:

- Create parent directory if missing
- Pretty-print JSON with 2-space indent and trailing newline
- Replace through a same-directory temporary file
- Stable key order: `widgets`, `layout`, `iconMode`, `contextMode`, `contextBarWidth`, `minimal`, `separator`, `spacing`

Path resolution remains `resolveRuntimeConfigPath()`:

1. explicit (if ever passed)
2. `PI_STATUSLINE_CONFIG`
3. `$PI_CODING_AGENT_DIR/statusline.json` (legacy fallback: `$PI_AGENT_DIR/statusline.json`) or `~/.pi/agent/statusline.json`

## Pure logic (testable)

Extract mutation helpers so UI is thin:

- `toggleWidget(widgets, id)`
- `moveWidget(widgets, id, "up" | "down")`
- `parseContextBarWidth(raw)`
- `parseWidgetSpacing(raw)`
- optional small helpers for menu labels

Interactive loop lives in `lib/configure.ts` (or similar) and receives a UI adapter + apply callback.

## Error handling

| Case | Behavior |
|------|----------|
| Non-TUI interactive entry | Text dump of config |
| Save failure | Error notify; config unchanged |
| Invalid width outside `4`–`40` or spacing outside `0`–`4` | Error notify; no change |
| Invalid JSON reload | Error notify; preserve memory config and block ordinary overwrite |
| Reset | Require explicit confirmation |
| Disable last widget | Warning; no change |
| Esc cancel on select/input | Return to parent; no side effects |

## Files

```text
extensions/statusline/
  lib/config.ts               # +saveStatuslineConfig
  lib/configure.ts            # menu + pure mutation helpers
  extensions/statusline.ts    # wire /statusline command
  tests/config.test.ts        # save roundtrip
  tests/configure.test.ts     # mutation/validation tests
  README.md                   # command docs
docs/plans/
  2026-07-16-statusline-interactive-config-design.md
```

## Non-goals

- Custom full-screen TUI widget editor
- Live preview pane beyond existing footer refresh
- Remote/multi-user config sync
- Changing footer rendering algorithm

## Test plan

1. Unit: save + load roundtrip
2. Unit: toggle/move constraints and boundaries
3. Unit: width/spacing validation and dot/bar separator rendering
4. Manual: `/statusline` in TUI toggles widget and footer updates; file on disk matches
