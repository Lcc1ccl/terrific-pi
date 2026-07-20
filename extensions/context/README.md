# context

Pi `/context` occupancy inspector. Inspection makes no model calls or session writes; an explicit confirmed compact action delegates to Pi's session compaction.

## Install

```bash
# settings.json packages (relative to ~/.pi/agent)
"../vendor/terrific-pi/extensions/context"
```

Or: `pi install /path/to/terrific-pi/extensions/context`

## Configure

Optional (trusted project overrides global), shared with sibling packages:

```text
~/.pi/agent/terrific.json
<project>/.pi/terrific.json
```

```json
{
  "context": { "topEntries": 10 }
}
```

See `examples/config.json`.

## Command

- `/context` — TUI inspector, or the complete text report outside TUI.
- `/context summary` — total context + estimated categories + largest entries.
- `/context details` — previews for the configured largest entries.
- `/context config` — TUI editor for `topEntries` in global or trusted-project scope, with reset override. It labels the selected write target separately from the effective value and source paths.
- TUI overlay: copy (`c`) / compact with confirmation (`x`) / details (`Enter`).
- Print mode writes the text summary to stdout.

## Verify

```bash
npm run check
```
