# mode

Pi `/mode` tool-permission modes. Does **not** change model or thinking level.

| Mode | Tools |
|------|--------|
| `ask` | `read`, `grep`, `find`, `ls` |
| `plan` | same read-only tools; Bash is disabled |
| `edit` | baseline tools from session start |
| `auto` | same tools as `edit` (label only) |

Status key for statusline: `pi-essentials-mode` (unchanged for compatibility).

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

File: `~/.pi/agent/pi-essentials.json` (or trusted project `.pi/pi-essentials.json`).

## Command

- `/mode [ask|plan|edit|auto]`
- Restricted modes restore the startup tool set before `/reload` or session shutdown
- Print mode writes the selected mode and active tools to stdout

## Verify

```bash
npm run check
```
