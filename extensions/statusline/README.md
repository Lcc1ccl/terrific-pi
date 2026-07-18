# statusline

Configurable statusline footer extension for [pi](https://pi.dev).

Built for pi's `setFooter` extension API: active-branch metrics, git context, and agent run state.

## Features

- Configurable widget order and numeric spacing (JSON)
- `layout: "single" | "stacked"` with canonical project/usage/environment/activity lines
- `iconMode: "emoji" | "plain"` (plugin-owned glyphs only; bars/colors unchanged)
- Path (home-relative `~`)
- Session name (when set via `/name`)
- Model + thinking level
- Execution mode and fast priority badges when active
- Active-branch token usage (`🔼input` / `🔽output`, or plain `in` / `out`)
- Active-branch cumulative cache hit rate (`🎯…%` or `cache …%`)
- Active-branch cost (`$x.xx`, hidden when zero)
- Context bar (remaining/used mode)
- Native OAuth **quota** for official Claude / Codex only
- Environment counts (context files / skills / tools) after first agent start
- Tool activity aggregates (active / success / error)
- Git branch (`main`/`master` is `🏠` in emoji mode) + committed branch diff (`+N -M`)
- Extension statuses (dedicated mode and fast badges excluded)
- LLM duration: current round / current process total (assistant stream only)
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

- default: `$PI_CODING_AGENT_DIR/statusline.json` or `~/.pi/agent/statusline.json`
- file override: `PI_STATUSLINE_CONFIG=/path/to.json`
- legacy directory fallback: `PI_AGENT_DIR`

`spacing` is the number of terminal space cells placed on each side of the fixed `·` separator. Default: `1`; minimum: `0`; maximum: `4`.

`contextBarWidth` is an integer terminal-cell width. Default: `10`; minimum: `4`; maximum: `40`.

Single-line layout follows the configured order exactly. Stacked layout uses canonical project/usage/environment/activity lines and preserves configured order within each line.

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
Context [█░░░░░░░░░] 4% · 🔼 12.5K · 🔽 3.2K · 🎯 76.9% · $0.42 · 📊 5h [█░░░] 7% · 7d [███░] 33%
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
| `tokens` | active-branch input/output totals, kept as one responsive unit |
| `cache` | active-branch cumulative cache hit rate |
| `cost` | active-branch cost USD |
| `context` | text context percent |
| `contextBar` | `Context` label + compact bar + percent |
| `branch` | git branch (`main`/`master` → `🏠` in emoji mode) |
| `branchDiff` | committed line diff from merge-base to `HEAD` vs default branch |
| `quota` | native OAuth Claude/Codex usage windows, including loading/first-load error state |
| `environment` | context files / skills / tools counts (low-contrast / dim) |
| `toolActivity` | per-tool active/success/error counts; metadata-only `process_update` is excluded |
| `progress` | extension status texts (excludes dedicated badges) |
| `duration` | current-round / current-process LLM time (`🕒` prefix in emoji mode) |
| `state` | Ready / Thinking / Working |

`toolActivity` counts business tools only. Process View's `process_update` publishes session metadata and is ignored at both tool start and tool end, preventing duplicate progress in the footer and editor-above HUD.

### Quota eligibility (strict)

`quota` is shown only when **all** of the following hold:

1. `quota` is present in `widgets`
2. current model uses Pi native `/login` OAuth (`modelRegistry.isUsingOAuth(model)`)
3. provider is official allowlist:
   - Codex: `provider=openai-codex`, `api=openai-codex-responses`, `baseUrl=https://chatgpt.com/backend-api`
   - Claude: `provider=anthropic`, `api=anthropic-messages`, `baseUrl=https://api.anthropic.com`
4. provider is **not** overridden by an extension registration

Otherwise: no token read, no network request, no cached foreign provider display. Eligible requests render `Usage …` while loading and `Usage unavailable` when the first load fails.

#### Claude semantics

Pi third-party harness OAuth calls may bill as **Extra** usage rather than subscription 5h/7d windows. Labels:

- `5h` / `7d` / model weekly windows = Claude account usage windows
- `Extra` = extra usage bucket when present

These are account-level signals, not a guarantee of the current Pi session budget.

#### Safety

- Tokens only via `getApiKeyAndHeaders()` in memory
- No reads of `auth.json`, `~/.codex/auth.json`, or Claude credentials files
- Fixed hosts, `redirect: "error"`
- Only required authentication headers are forwarded to fixed usage hosts
- In-process cache only (5 min TTL); no disk snapshot
- No usage request while `PI_OFFLINE=1`, `true`, or `yes`

### Commands

```text
/statusline          # open interactive config menu (TUI)
/statusline reload   # reload config file
```

In TUI mode, `/statusline` opens a nested menu:

- **Widgets**: `Space` toggle, configured select keys to navigate, configured cursor keys to move, Enter done
- set `layout`, `iconMode`, `contextMode`, `contextBarWidth`, `minimal`, spacing
- enum menus put the current value first and mark current/default values
- numeric inputs are prefilled with the current value
- show / reload / confirmed reset config

Each successful change is atomically written to the config file and the footer refreshes. Invalid JSON is reported and is not overwritten by ordinary menu changes; use a successful reload or confirmed reset to clear that state.

### Data scope and refresh

| data | source and scope |
|------|------------------|
| path, model, context | live pi context; unavailable context renders as `Context ?` |
| tokens, cache, cost | assistant usage entries on the active session branch; refreshed after assistant completion and branch/tree changes |
| branch | pi footer data; branch diff is local Git committed-line data only and excludes the working tree |
| mode, fast, progress | pi extension status map; the renderer removes terminal control sequences from every dynamic segment |
| duration, tools, environment | process-local event aggregates; they are not restored from session history |
| quota | official provider account usage endpoints; account-level, cached, and independent of active-branch totals |

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
