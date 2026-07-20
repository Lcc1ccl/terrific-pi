# context

Pi `/context` occupancy inspector. No model calls, no session writes.

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

- `/context` — total context + category breakdown (estimated) + largest entries
- TUI overlay: compact (`c`) / details (`Enter`) / copy
- Print mode writes the text summary to stdout

## Verify

```bash
npm run check
```
