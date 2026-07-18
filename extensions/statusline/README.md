# statusline

Configurable statusline footer extension for [pi](https://pi.dev).

Built for pi's `setFooter` extension API: session metrics, git context, and agent run state.

## Features

- Configurable widget order and numeric spacing (JSON)
- `layout: "single" | "stacked"` multi-line HUD grouping
- `iconMode: "emoji" | "plain"` (plugin-owned glyphs only; bars/colors unchanged)
- Path (home-relative `~`)
- Session name (when set via `/name`)
- Model + thinking level
- Execution mode and fast priority badges when active
- Token usage (`input` / `output`, or plain `in` / `out`)
- Cache hit rate (`🎯…%` or `cache …%`)
- Session cost (`$x.xx`, hidden when zero)
- Context bar (remaining/used mode)
- Native OAuth **quota** for official Claude / Codex only
- Environment counts (context files / skills / tools) after first agent start
- Tool activity aggregates (active / success / error)
- Git branch (`main`/`master` is `🏠` in emoji mode) + non-empty branch diff (`+N -M`)
- Extension task progress statuses (mode and fast badges excluded)
- LLM duration: current round / session total (assistant stream only)
- Run state: Thinking / Working / Ready
- Interactive `/statusline` configurator and `/statusline reload`

## Default layout

Package defaults stay single-line emoji and do **not** enable the new widgets:

```text
~/proj · session · model high ·  · 🔼 1.5K · 🔽 800 · 🎯 66.7% · $0.42 · Context [██████░░░░] 60% · 🏠 · +12 -3 · 🕒 12.3s / 1m45s · Ready
```

## Install

```bash
pi install /path/to/terrific-pi/extensions/statusline
```

## Configuration

Optional config file:

- default: `~/.pi/agent/statusline.json`
- override: `PI_STATUSLINE_CONFIG=/path/to.json`

`spacing` is the number of terminal space cells placed on each side of the fixed `·` separator. Default: `1`; minimum: `0`; maximum: `4`.

```json
{
  "layout": "single",
  "iconMode": "emoji",
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

### Recommended stacked HUD

```json
{
  "layout": "stacked",
  "iconMode": "emoji",
  "widgets": [
    "path",
    "session",
    "model",
    "branch",
    "branchDiff",
    "mode",
    "fast",
    "contextBar",
    "tokens",
    "cache",
    "cost",
    "quota",
    "environment",
    "toolActivity",
    "progress",
    "duration",
    "state"
  ],
  "contextMode": "used",
  "contextBarWidth": 10,
  "minimal": false,
  "spacing": 1
}
```

Example stacked output:

```text
[Fable 5] · ~/vendor/terrific-pi · 🏠 · +12 -3 · EDIT · 
Context [█░░░░░░░░░] 4% · 12.5K · 3.2K · 🎯76.9% · $0.42 · 📊 5h [█░░░] 7% · 7d [███░] 33%
2 context files · 67 skills · 7 tools
✓ Read x6 · ✓ Bash x3 · Ready · 12.3s / 1m45s
```

### Widget ids

| id | description |
|----|-------------|
| `path` | cwd with `~` abbreviation |
| `session` | session display name |
| `model` | model id + thinking level |
| `mode` | active `/mode` badge |
| `fast` | `` (or `fast` in plain mode) while `/fast` is on |
| `tokens` | input/output totals (`🔼` / `🔽` in emoji mode, spaced) |
| `cache` | cache hit rate (`🎯` spaced in emoji mode) |
| `cost` | session cost USD |
| `context` | text context percent |
| `contextBar` | `Context` label + compact bar + percent |
| `branch` | git branch (`main`/`master` → `🏠` in emoji mode) |
| `branchDiff` | non-empty diff vs default branch |
| `quota` | native OAuth Claude/Codex usage windows |
| `environment` | context files / skills / tools counts (low-contrast / dim) |
| `toolActivity` | per-tool active/success/error counts |
| `progress` | extension status texts (excludes dedicated badges) |
| `duration` | current-round / session LLM time (`🕒` prefix in emoji mode) |
| `state` | Ready / Thinking / Working |

### Quota eligibility (strict)

`quota` is shown only when **all** of the following hold:

1. `quota` is present in `widgets`
2. current model uses Pi native `/login` OAuth (`modelRegistry.isUsingOAuth(model)`)
3. provider is official allowlist:
   - Codex: `provider=openai-codex`, `api=openai-codex-responses`, `baseUrl=https://chatgpt.com/backend-api`
   - Claude: `provider=anthropic`, `api=anthropic-messages`, `baseUrl=https://api.anthropic.com`
4. provider is **not** overridden by an extension registration

Otherwise: no token read, no network request, no cached foreign provider display.

#### Claude semantics

Pi third-party harness OAuth calls may bill as **Extra** usage rather than subscription 5h/7d windows. Labels:

- `5h` / `7d` / model weekly windows = Claude account usage windows
- `Extra` = extra usage bucket when present

These are account-level signals, not a guarantee of the current Pi session budget.

#### Safety

- Tokens only via `getApiKeyAndHeaders()` in memory
- No reads of `auth.json`, `~/.codex/auth.json`, or Claude credentials files
- Fixed hosts, `redirect: "error"`
- In-process cache only (5 min TTL); no disk snapshot

### Commands

```text
/statusline          # open interactive config menu (TUI)
/statusline reload   # reload config file
```

In TUI mode, `/statusline` opens a nested menu:

- **Widgets** (Codex-style): `Space` toggle, `↑/↓` select, `←/→` move, Enter done
- set `layout`, `iconMode`, `contextMode`, `contextBarWidth`, `minimal`, spacing
- show / reload / reset config

Each successful change is written immediately to the config file and the footer refreshes.

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
│   ├── quota.ts
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
