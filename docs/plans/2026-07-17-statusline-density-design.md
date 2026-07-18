# Statusline Density Design

Date: 2026-07-17
Scope: `extensions/statusline`

## Decisions

- Configure symmetric spacing around `·`; separator selection was later superseded by the 2026-07-18 color hierarchy design (`·` or single-cell `│`).
- Render `main` as `🏠` and omit `branchDiff` when both counts are zero.
- Derive state from stream events: reasoning is `Thinking`, text/tool-call generation and tool execution are `Working`, and settled is `Ready`.
- Render the context bar without the `ctx` prefix.
- Render token totals as `⬆️input` and `⬇️output`.

## Validation

- Unit-test formatting, widget omission, defaults, and stream-state mapping.
- Run the complete statusline test suite and reload the extension in pi.
