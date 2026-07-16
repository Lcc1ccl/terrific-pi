# statusline

Configurable statusline footer extension for [pi](https://pi.dev).

Built for pi's `setFooter` extension API: session metrics, git context, and agent run state in one compact line.

## Features

- Configurable widget order (JSON)
- Path (home-relative `~`)
- Session name (when set via `/name`)
- Model + thinking level
- Token usage (input / output, compact K/M/B/T)
- Cache metrics (`↓… ↑… 🎯…%`)
- Session cost (`$x.xx`, hidden when zero)
- Context bar (remaining/used mode)
- Git branch + branch diff vs default branch (`+N -M`)
- Extension task progress statuses
- Run state: Ready / Thinking / Working
- Interactive `/statusline` configurator and `/statusline reload`

## Default layout

```text
~/proj · session · model high · 1.5K in · 0.8K out · ↓4K ↑500 🎯66.7% · $0.42 · ctx [██████░░░░] 60% · main · +12 -3 · Ready
```

## Install

```bash
pi install /path/to/terrific-pi/extensions/statusline
```

## Configuration

Optional config file:

- default: `~/.pi/agent/statusline.json`
- override: `PI_STATUSLINE_CONFIG=/path/to.json`

Example:

```json
{
  "widgets": [
    "path",
    "session",
    "model",
    "tokens",
    "cache",
    "cost",
    "contextBar",
    "branch",
    "branchDiff",
    "progress",
    "state"
  ],
  "contextMode": "remaining",
  "contextBarWidth": 10,
  "minimal": false,
  "separator": " · "
}
```

### Widget ids

| id | description |
|----|-------------|
| `path` | cwd with `~` abbreviation |
| `session` | session display name |
| `model` | model id + thinking level |
| `tokens` | input/output totals |
| `cache` | cache read/write + hit rate |
| `cost` | session cost USD |
| `context` | text context percent |
| `contextBar` | compact context bar + percent |
| `branch` | git branch |
| `branchDiff` | diff vs default branch |
| `progress` | extension status texts |
| `state` | Ready / Thinking / Working |

### Commands

```text
/statusline          # open interactive config menu (TUI)
/statusline reload   # reload config file
```

In TUI mode, `/statusline` opens a nested menu to:

- **Widgets** (Codex-style): `Space` toggle, `↑/↓` select, `←/→` move, Enter done
- set `contextMode`, `contextBarWidth`, `minimal`, `separator`
- show / reload / reset config

Each successful change is written immediately to the config file and the footer refreshes.

In non-TUI modes, `/statusline` prints the active config as text.

## Structure

```text
statusline/
├── package.json
├── README.md
├── extensions/
│   └── statusline.ts
├── lib/
│   ├── config.ts
│   ├── configure.ts
│   ├── format.ts
│   ├── render.ts
│   ├── types.ts
│   ├── usage.ts
│   ├── widgets-setup.ts
│   └── widgets.ts
└── tests/
```

## Develop

```bash
cd extensions/statusline
npm test
```
