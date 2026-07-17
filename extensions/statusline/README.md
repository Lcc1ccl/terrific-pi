# statusline

Configurable statusline footer extension for [pi](https://pi.dev).

Built for pi's `setFooter` extension API: session metrics, git context, and agent run state in one compact line.

## Features

- Configurable widget order and numeric spacing (JSON)
- Path (home-relative `~`)
- Session name (when set via `/name`)
- Model + thinking level
- Execution mode and fast priority badges when active
- Token usage (`⬆️input` / `⬇️output`, compact K/M/B/T)
- Cache hit rate (`🎯…%`)
- Session cost (`$x.xx`, hidden when zero)
- Context bar (remaining/used mode, no text prefix)
- Git branch (`main` is `🏠`) + non-empty branch diff (`+N -M`)
- Extension task progress statuses (mode and fast badges excluded)
- LLM duration: current round / session total (assistant stream only)
- Run state: Thinking while reasoning, Working while generating or executing tools, Ready when settled
- Interactive `/statusline` configurator and `/statusline reload`

## Default layout

```text
~/proj · session · model high ·  · ⬆️1.5K · ⬇️800 · 🎯66.7% · $0.42 · [██████░░░░] 60% · 🏠 · +12 -3 · 12.3s / 1m45s · Ready
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

`spacing` is the number of terminal space cells placed on each side of the fixed `·` separator. Default: `1`; minimum: `0`; maximum: `4`. The separator itself is always present and is not configurable.

```json
{
  "widgets": [
    "path",
    "session",
    "model",
    "fast",
    "tokens",
    "cache",
    "cost",
    "contextBar",
    "branch",
    "branchDiff",
    "progress",
    "duration",
    "state"
  ],
  "contextMode": "remaining",
  "contextBarWidth": 10,
  "minimal": false,
  "spacing": 1
}
```

### Widget ids

| id | description |
|----|-------------|
| `path` | cwd with `~` abbreviation |
| `session` | session display name |
| `model` | model id + thinking level |
| `mode` | active `/mode` badge |
| `fast` | single-column `` while `/fast` priority processing is on |
| `tokens` | input/output totals with `⬆️` / `⬇️` prefixes |
| `cache` | cache hit rate |
| `cost` | session cost USD |
| `context` | text context percent |
| `contextBar` | compact context bar + percent |
| `branch` | git branch (`main` renders as `🏠`) |
| `branchDiff` | non-empty diff vs default branch |
| `progress` | extension status texts (excludes dedicated badges such as `mode`, `fast`, and `ponytail`) |
| `duration` | current-round / session LLM time (`12.3s / 1m45s`); assistant stream only, excludes tools + idle |
| `state` | Ready / Thinking / Working, driven by agent stream/tool events |

### Commands

```text
/statusline          # open interactive config menu (TUI)
/statusline reload   # reload config file
```

In TUI mode, `/statusline` opens a nested menu whose top-level selection wraps from first to last and last to first:

- **Widgets** (Codex-style): `Space` toggle, `↑/↓` select, `←/→` move, Enter done
- set `contextMode`, `contextBarWidth`, `minimal`, and numeric widget spacing (`0`–`4`)
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
│   ├── duration.ts
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
