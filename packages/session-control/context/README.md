# context

Pi `/context` occupancy inspector. Inspection makes no model calls or session writes; an explicit confirmed compact action delegates to Pi's session compaction.

## Install

Install the `terrific-pi` root package:

```bash
pi install /path/to/terrific-pi
```

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
- `/context summary` — raw context occupancy, conservative safe-input occupancy, estimated categories, and largest entries.
- `/context details` — previews for the configured largest entries.
- `/context config` — TUI editor for `topEntries` in global or trusted-project scope, with reset override. It labels the selected write target separately from the effective value and source paths.
- TUI overlay: copy (`c`) / compact with confirmation (`x`) / details (`Enter`).
- Print mode writes the text summary to stdout.

The safe-input figure is intentionally more conservative than Pi's raw percentage: when the subtraction leaves a positive budget, it subtracts the selected model's maximum output budget plus 16,384 tokens from the advertised context window. Models whose advertised maximum output consumes that budget show only Pi's raw occupancy instead of a synthetic 100%. This is a warning budget, not a claim about the current effective Pi compaction setting. Inspection never triggers automatic compaction; only the confirmed `x` action calls `ctx.compact()`.

## Verify

```bash
npm run check
```
