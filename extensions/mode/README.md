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

- `/mode [ask|plan|edit|auto]`
- Restricted modes only add auxiliary tools that were present in the captured startup baseline
- Restricted modes restore the startup tool set before `/reload` or session shutdown
- Print mode writes the selected mode and active tools to stdout

## Verify

```bash
npm run check
```
