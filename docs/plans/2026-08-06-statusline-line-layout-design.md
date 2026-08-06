# Statusline LINE0-4 Layout Design

Date: 2026-08-06
Scope: `packages/interface/statusline`

## Goal

Replace the semantic `widgets` + `layout` + `widgetGroups` model with five explicit widget lines:

```json
{
  "lines": {
    "line0": ["model", "mode", "fast"],
    "line1": ["path", "session", "tokens", "state"],
    "line2": [],
    "line3": [],
    "line4": []
  }
}
```

`line0` renders in Appearance's editor bottom-right border. `line1` through `line4` render below the editor through the statusline footer. Any widget may be placed on any line. Empty or currently unavailable lines consume no terminal rows.

## Configuration Contract

- `lines` is the only persisted widget source of truth.
- Presence in any line enables a widget; absence disables it.
- Array order is render order within that line.
- A widget may occur only once. Parsing keeps its first valid occurrence in `line0` to `line4` order.
- Unknown widget ids are ignored. A configuration with no valid widgets falls back to defaults.
- Saved configuration always writes all five line arrays and does not write `widgets`, `layout`, or `widgetGroups`.

## Legacy Read Migration

Legacy files remain readable:

- `model`, `mode`, and `fast` migrate to `line0`.
- Legacy `layout: "single"` places every remaining enabled widget in `line1`.
- Legacy `layout: "stacked"` maps project, usage, environment, and activity groups to `line1` through `line4`, including valid `widgetGroups` overrides.
- A valid new `lines` object takes precedence over legacy fields.

Migration is in-memory. The next successful `/statusline` change or save writes only the new format.

## Runtime Behavior

- The editor bridge projects every available segment assigned to `line0`; there is no widget allowlist.
- While Appearance owns the editor, the footer renders only `line1` through `line4`.
- Without an active Appearance editor owner, `line0` is rendered as the first footer row so configured information is not lost.
- Width fitting, segment priorities, colors, separators, spacing, and optional-widget hiding remain unchanged per line.

## Configurator

The Widgets editor displays `LINE0` through `LINE4`. Widgets can be toggled, reordered within a line, or moved freely across line boundaries. Disabled widgets default to a transient `LINE1` placement until enabled; no extra disabled-placement state is persisted.

The obsolete Layout selector is removed. Minimal profile writes its own five-line arrangement and preserves run notification.

## Verification

- Config parse/save and legacy migration tests.
- Renderer tests for arbitrary `line0` content and independent `line1`-`line4` rows.
- Configurator/component tests for free cross-line movement and immediate persistence.
- Lifecycle tests for Appearance ownership and footer fallback.
- Package `npm run check`, followed by root `npm run check`.
