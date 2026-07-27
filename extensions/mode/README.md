# mode

Pi `/mode` tool-permission modes. Does **not** change model or thinking level.

| Mode | Tools |
|------|--------|
| `ask` | `read`, `grep`, `find`, `ls`, plus installed `aux_summarize` and fixed `web_research` |
| `plan` | same read-only tools; Bash and `git_finalize` are disabled |
| `edit` | baseline tools from session start |
| `auto` | same tools as `edit` (label only) |

Status key for statusline: `mode`.

## Install

```bash
"../vendor/terrific-pi/extensions/mode"
```

Enable badge: add `"mode"` to `~/.pi/agent/statusline.json` widgets.

## Configure

```json
{
  "mode": { "default": "edit", "persistPerSession": true }
}
```

File: `~/.pi/agent/terrific.json` (or trusted project `.pi/terrific.json`).

## Command

- `/mode [ask|plan|edit|auto]` switches the current session mode.
- `/mode config` edits only the global default and session-persistence fields. Its TUI and print summaries show the global write target separately from the effective value and trusted-project source chain.
- Restricted modes only add auxiliary tools that were present in the captured startup baseline.
- Restricted modes restore the startup tool set before `/reload` or session shutdown.
- Print mode writes the selected mode and active tools to stdout.

## Appearance

Package-owned menus opt into the Terrific native profile only when `$PI_CODING_AGENT_DIR/terrific.json` contains the exact global value:

```json
{
  "appearance": { "profile": "terrific-native-v1" }
}
```

The profile is reread whenever a mode command opens a menu. Missing, malformed, non-object, `off`, unknown, and project-local appearance values fail closed without a mode notification. When active, mode menus use one compact responsive boundary, accented selection, muted em-dash descriptions, rebound-key hints, circular navigation, and filtering only for lists longer than 10 items. `TERM=dumb` uses ASCII chrome. Mode permissions, persistence, status, and command behavior are unchanged.

Rollback by setting `appearance.profile` to `off` or removing it; the next mode menu uses the original renderer.

## Verify

```bash
npm run check
npm run benchmark
```

The opt-in benchmark measures exactly 30 timed samples of 100 active pure renders at 160 columns, reports nearest-rank per-render p95, and requires it below 16 ms.
