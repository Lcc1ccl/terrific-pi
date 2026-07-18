# Statusline Color Hierarchy Design

Date: 2026-07-18
Scope: `extensions/statusline`

## Goal

Reduce simultaneous hues, make normal information quiet and readable in both built-in pi themes, and reserve color for current activity, thinking level, and exceptional states.

## Decisions

1. Follow the active pi theme. Do not maintain extension-owned RGB palettes or a separate theme selector.
2. Use `text`, `muted`, and `dim` for the normal hierarchy. Use `accent`, `warning`, `error`, and `success` only for their semantic states.
3. Render thinking level with pi's native `thinkingOff` through `thinkingMax` tokens.
4. Keep bars neutral. Color only the percentage above pi's native thresholds: warning above 70%, error above 90%.
5. Keep package defaults compatible (`dot`, `emoji`), while the recommended stacked HUD uses `bar`, `plain`.

## Separator

Add `separator: "dot" | "bar"` to `statusline.json`:

- `dot` renders `·` and remains the package default.
- `bar` renders the single-cell box-drawing character `│`.
- `/statusline` exposes **Widget separator** immediately before **Widget spacing**.
- The setting changes widget boundaries only. Related values inside one widget remain dot-separated.
- Arbitrary separator strings are rejected and fall back to `dot`.

## Built-in Theme Reference

| Role | Dark | Light |
|---|---|---|
| `text` | `#d4d4d4` | `#1f2328` |
| `muted` | `#808080` | `#6c6c6c` |
| `dim` | `#666666` | `#767676` |
| `accent` | `#8abeb7` | `#5a8080` |
| `success` | `#b5bd68` | `#588458` |
| `warning` | `#ffff00` | `#9a7326` |
| `error` | `#cc6666` | `#aa5555` |

Thinking tokens remain owned by pi so custom themes continue to work:

| Level | Dark | Light |
|---|---|---|
| off | `#505050` | `#b0b0b0` |
| minimal | `#6e6e6e` | `#767676` |
| low | `#5f87af` | `#547da7` |
| medium | `#81a2be` | `#5a8080` |
| high | `#b294bb` | `#875f87` |
| xhigh | `#d183e8` | `#8b008b` |
| max | `#ff5fff` | `#af005f` |

## Widget Mapping

- Model id and normal numeric values: `text`; thinking level: matching native thinking token.
- Path, session, mode, branch, labels, and inactive glyphs: `muted`.
- Separators, empty bars, environment metadata, and `Ready`: `dim`.
- `Working`, active tools, and live progress: `accent`; `Thinking`: current thinking token; fast emoji: `warning`.
- Tool success/failure glyphs: `success` / `error`; names stay muted and counts stay neutral; git `+` / `-` signs retain success/error semantics.

## Cross-extension Integration

No changes are required in `mode`, `fast`, `context`, or `btw`. Their existing status keys and events remain unchanged. The existing `thinking_level_select` handler already requests a footer rerender.

## Non-goals

- Per-widget color configuration
- Extension-owned light/dark palette selection
- A third icon mode
- Arbitrary separator strings

## Validation

- Unit-test separator parsing, persistence, menu placement, widget versus inline separators, and width fitting.
- Unit-test thinking token mapping, state hierarchy, neutral bars, and 70/90 thresholds.
- Run the complete statusline test suite and manually reload in pi with the built-in dark and light themes.
