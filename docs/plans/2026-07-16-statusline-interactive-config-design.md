# Statusline Interactive Config Design

Date: 2026-07-16  
Scope: `extensions/statusline`

## Goal

Make `/statusline` an interactive TUI configuration console so users can fully configure the footer in-terminal without hand-editing JSON.

## Decisions

1. **UI approach:** Nested `ctx.ui.select` / `ctx.ui.input` menus (not a custom full-screen panel).
2. **Persistence:** Immediate apply — each successful change writes `statusline.json` and refreshes the footer.
3. **Compatibility:** Keep `/statusline reload`. Non-TUI modes still print config text.

## Command behavior

### `/statusline` (TUI)

Enter a main-menu loop until the user chooses **Done** or cancels.

Main menu actions:

- Widgets (toggle + reorder, Codex-style)
- Context mode
- Context bar width
- Minimal mode
- Widget spacing
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

Single Codex-style multi-select screen:

- List all known widget ids: enabled first (config order), then disabled (catalog order).
- `Space` toggles `[x]` / `[ ]`.
- `↑/↓` (or `j/k`) moves the selection cursor.
- `←/→` (or `h/l`) swaps the focused item with its neighbor (order of enabled items = footer order).
- Enter / Esc exits back to the main menu.
- Constraint: at least one widget must remain enabled.
- Boundary moves are no-ops.
- Each successful toggle/move applies immediately (footer + JSON).

### Context mode

Select `remaining` or `used`.

### Context bar width

`ctx.ui.input` with current value prefilled.

- Valid: integer 1–40
- Invalid: error notify, no change

### Minimal mode

Select on/off.

### Widget spacing

`ctx.ui.input` with the current numeric value prefilled. The title shows default `1`, minimum `0`, and maximum `4`.

- Valid: integer `0`–`4`, measured in terminal space cells on each side
- The `·` separator is fixed and cannot be removed or changed

### Show / Reload / Reset / Done

- Show: multi-line notify of active config
- Reload: reread file into memory + refresh
- Reset: write `DEFAULT_CONFIG` and refresh
- Done: exit loop

## Immediate apply pipeline

On each successful mutation:

1. Update in-memory `config`
2. `saveStatuslineConfig(configPath, config)`
3. `requestRender()`
4. Short success notify

On save failure: error notify; do not keep the in-memory mutation (or roll back to previous snapshot).

## Persistence details

Add `saveStatuslineConfig(path, config)`:

- Create parent directory if missing
- Pretty-print JSON with 2-space indent and trailing newline
- Stable key order: `widgets`, `contextMode`, `contextBarWidth`, `minimal`, `spacing`

Path resolution remains `resolveRuntimeConfigPath()`:

1. explicit (if ever passed)
2. `PI_STATUSLINE_CONFIG`
3. `$PI_AGENT_DIR/statusline.json` or `~/.pi/agent/statusline.json`

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
| Invalid width / spacing outside `0`–`4` | Error notify; no change |
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
3. Unit: width/spacing validation and immutable separator rendering
4. Manual: `/statusline` in TUI toggles widget and footer updates; file on disk matches
