# statusline

Configurable editor-border and footer status extension for [pi](https://pi.dev).

Built for pi's `setFooter` extension API plus Appearance's versioned editor bridge: active-branch metrics, git context, and agent run state.

## Features

- Five explicit widget lines with independent order: `LINE0` at the editor top-left, `LINE1` at the editor bottom-right, and `LINE2`-`LINE4` as footer rows
- Any widget can be assigned to any line; no project/usage/environment/activity classification
- **Minimal profile**: pi built-in footer core + mode/fast/state, with abbreviated labels (`ctx`/`CH`, keep `in`/`out`/`$`)
- `toolActivityMode: "detailed" | "compact"` for per-tool or core_tools/aux_tools aggregates
- `iconMode: "emoji" | "plain" | "nerd" | "ascii" | "auto"` (plugin-owned glyphs only; bars/colors unchanged)
- Path (home-relative `~`) with a non-plain folder marker and elastic tail-preserving truncation
- Session name (when set via `/name`)
- Model + thinking level using pi's native thinking colors
- Execution mode and fast priority badges when active
- Automatic editor placement: while Appearance owns the editor, `LINE0` and `LINE1` render on separate editor borders and `LINE2`-`LINE4` remain footer rows; without that owner all five lines fall back to the footer
- Active-branch token usage (`🔼input` / `🔽output`, or plain `in` / `out`)
- Active-branch cumulative cache hit rate (`🎯…%` or `cache …%`)
- Active-branch main cost (`$x.xx`, hidden when zero); Auxiliary reports its own usage separately and never merges it into footer totals
- Context bar (remaining/used mode)
- Native OAuth **quota** for official Claude / Codex only
- Environment counts (context files / skills / tools) after first agent start
- Current agent-run tool activity aggregates (per-tool active/success + total errors)
- Git branch (`⑂ branch` in emoji mode) + committed branch diff (`+N -M`)
- Optional `worktree` unit for porcelain-v2 branch/ahead/behind/stash/conflict/staged/modified/untracked state
- Optional `runtime` unit for deterministic project runtime/version detection
- Optional settled-run metric widgets: `runTps`, `runTtft`, `runDuration`, `runTokens`, `runStalls`, and `runCostRate`; each is independently placed and toggled
- Optional settled-run notification, independent from the metric widgets
- Extension statuses (dedicated mode, fast, and ponytail statuses excluded)
- Agent duration: current request / current process active total (includes tools and child pi processes)
- Run state: Thinking / Working / Waiting / Ready
- Interactive `/statusline` configurator and `/statusline reload`

## Default lines

The package default assigns model metadata to `LINE0` and the ordinary status row to `LINE1`. Optional widgets remain disabled.

With Appearance enabled:

```text
editor top-left:     model high · EDIT · 
editor bottom-right: 📁 ~/proj · session · 🔼 1.5K · 🔽 800 · 🎯 66.7% · $0.42 · 🪟 [██████░░░░] 60% · ⑂ main · +12 -3 · 🕒 12s / 1m45s · Ready
```

`mode` and `fast` are configured by default but render only while active. Without an active Appearance editor owner, nonempty `LINE0` through `LINE4` render as footer rows in order so configured information is not lost. `/statusline` remains the configuration owner in both cases.

## Install

Install the `terrific-pi` root package. For local development:

```bash
pi install /path/to/terrific-pi
```

## Configuration

Optional config file:

- default: `$PI_CODING_AGENT_DIR/statusline.json` or `~/.pi/agent/statusline.json`
- file override: `PI_STATUSLINE_CONFIG=/path/to.json`
- legacy directory fallback: `PI_AGENT_DIR`

`lines` is the only persisted widget source of truth:

- `line0` renders at the editor top-left when Appearance owns it.
- `line1` renders at the editor bottom-right with an independent width budget.
- `line2` through `line4` render as independent footer rows below the editor.
- Without an active Appearance owner, all five lines render as footer rows.
- Presence enables a widget; absence disables it.
- Array order is the render order within that line.
- Any widget can be placed on any line.
- Duplicate ids keep their first occurrence in `line0` to `line4` order.
- Empty or currently unavailable lines consume no terminal rows.

`separator` accepts `"dot"` (`·`) or `"bar"` (`│`). Default: `"dot"`. It applies between widgets; related values inside a widget remain dot-separated.

`spacing` is the number of terminal space cells placed on each side of the widget separator. Default: `1`; minimum: `0`; maximum: `4`.

`contextBarWidth` is an integer terminal-cell width. Default: `10`; minimum: `4`; maximum: `40`.

```json
{
  "lines": {
    "line0": ["model", "mode", "fast"],
    "line1": [
      "path",
      "session",
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
    "line2": [],
    "line3": [],
    "line4": []
  },
  "iconMode": "emoji",
  "contextMode": "remaining",
  "contextBarWidth": 10,
  "minimal": false,
  "separator": "dot",
  "spacing": 1,
  "toolActivityMode": "compact",
  "runNotification": false
}
```

Legacy `widgets`, `layout`, and `widgetGroups` files remain readable. On load, `model`/`mode`/`fast` migrate to `LINE0`; old single layouts migrate remaining widgets to `LINE1`; old stacked groups migrate to `LINE1`-`LINE4`. The next successful save writes only `lines`.

`toolActivityMode` defaults to `compact` so enabling `toolActivity` later stays dense. In `/statusline`, **Context & usage** is shown only when at least one of `context`, `contextBar`, or `toolActivity` is enabled on any line.

### Minimal profile

Based on pi's built-in footer core plus `mode`, `fast`, and run `state`. `/statusline` -> **Minimal profile** -> `on` writes:

```json
{
  "lines": {
    "line0": ["model", "mode", "fast"],
    "line1": ["path", "session", "branch", "tokens", "cache", "cost", "context", "progress", "state"],
    "line2": [],
    "line3": [],
    "line4": []
  },
  "iconMode": "plain",
  "contextMode": "used",
  "contextBarWidth": 10,
  "minimal": true,
  "separator": "dot",
  "spacing": 1,
  "toolActivityMode": "compact"
}
```

Example with Appearance enabled:

```text
editor top-left:     model high · EDIT · fast
editor bottom-right: ~/proj · session · main · in 1.5K · out 800 · CH 66.7% · $0.42 · ctx 40% · task 1/2 · Ready
```

- **on**: overwrites lines/iconMode/contextMode/separator/spacing/toolActivityMode, sets `minimal: true`, and preserves `runNotification`
- **off**: sets `minimal: false` only; lines stay configured
- `minimal: true` alone enables abbreviated labels without changing lines:
  - tokens keep `in`/`out` (or emoji arrows)
  - cost keeps `$`
  - cache -> `CH ...%`
  - context / contextBar -> `ctx ...`
  - duration -> `t ...`
- omitted from the profile: `branchDiff`, `contextBar`, `duration`, `quota`, `environment`, `toolActivity`, `worktree`, `runtime`, and all `run*` metric widgets

### Recommended multi-line HUD

```json
{
  "lines": {
    "line0": ["model", "mode", "fast"],
    "line1": ["path", "session", "branch", "branchDiff"],
    "line2": ["contextBar", "tokens", "cache", "cost", "quota"],
    "line3": ["environment", "runtime", "worktree"],
    "line4": ["toolActivity", "progress", "duration", "state"]
  },
  "iconMode": "plain",
  "contextMode": "used",
  "contextBarWidth": 10,
  "minimal": false,
  "separator": "bar",
  "spacing": 1
}
```

Example editor metadata and footer rows:

```text
editor top-left:     model high · EDIT · fast
editor bottom-right: ~/vendor/terrific-pi │ session │ main │ +12 -3
context [█░░░░░░░░░] 4% │ in 12.5K · out 3.2K │ cache 76.9% │ $0.42 │ usage 5h [░░░░░░] 7% · 7d [██░░░░] 33%
2 context files · 67 skills · 7 tools │ node 22.10.0 │ git main
ok Read x6 · ok Bash x3 │ task 1/2 │ time 12s / 1m45s │ Ready
```

### Color hierarchy

The footer follows the active pi theme rather than maintaining separate RGB palettes:

- model ids and paths use `accent`; branch names and cost use `mdHeading`
- normal values use `text`; labels and supporting metadata use `muted`; separators, idle state, and tertiary metadata use `dim`
- tool status glyphs use `accent` / `success` / `error`; names stay muted and counts stay neutral
- fast emoji uses `warning` (gold/yellow); context and quota bars stay neutral, with only high percentages colored
- thinking levels use `thinkingOff` through `thinkingMax`, the same tokens as pi's editor border

`plain` mode is recommended for a restrained HUD because terminal emoji retain their own colors.

### Widget ids

| id | description |
|----|-------------|
| `path` | cwd with `~` abbreviation, non-plain folder marker, and left ellipsis under width pressure |
| `session` | session display name |
| `model` | model id + thinking level |
| `mode` | active `/mode` badge with quiet risk-ladder colors (ASK dim · PLAN muted · EDIT text · AUTO soft thinkingLow) |
| `fast` | `` (or `fast` in plain mode) while `/fast` is on |
| `tokens` | active-branch main-session input/output totals |
| `cache` | active-branch cumulative cache hit rate |
| `cost` | active-branch main-session cost USD |
| `context` | text context percent with a window marker |
| `contextBar` | window marker + compact bar + percent |
| `branch` | git branch with `⑂` in emoji mode |
| `branchDiff` | committed line diff from merge-base to `HEAD` vs default branch |
| `quota` | native OAuth Claude/Codex usage windows, including loading/first-load error state |
| `environment` | context files / skills / tools counts (low-contrast / dim) |
| `toolActivity` | current agent-run tool counts; `detailed` keeps per-tool rows, `compact` shows error total + `core_tools` (bash/edit/read/write) + `aux_tools` (web_research/aux_summarize/git_finalize); metadata-only `process_update` is excluded |
| `worktree` | porcelain-v2 branch/ahead/behind/stash/conflict/rename/delete/staged/modified/untracked summary; disabled means no Git status command |
| `runtime` | project-marker runtime and optional version; ambiguous projects render `runtime ?`; disabled means no version command |
| `runTps` | aggregate output tokens per generation second for the last settled agent run |
| `runTtft` | first-turn time to first token for the last settled agent run |
| `runDuration` | wall duration of the last settled agent run |
| `runTokens` | input/output usage for the last settled agent run; unavailable usage renders `usage ?` |
| `runStalls` | streamed stall count and duration for the last settled agent run; hidden when zero |
| `runCostRate` | effective USD per million tokens for the last settled agent run; hidden when unavailable |
| `progress` | extension status texts (excludes dedicated badges and `auxiliary`, which lives in Taskboard) |
| `duration` | current-request / current-process active time (`🕒` prefix in emoji mode); includes tools and child pi processes, excludes idle between requests |
| `state` | Ready / Thinking / Working / Waiting (tools, subagent, or Taskboard wait/block) |

`runNotification` defaults to `false` and includes all available run metrics. Enabling any `run*` widget or the notification starts the same event-driven tracker; widgets and notification may be enabled together. Each metric validates only its own required fields, so missing cost metadata does not hide available token or TPS data. The tracker keeps one settled snapshot and clears widget values when the next agent run starts.

`toolActivity` resets at each agent run and counts business tools only. Taskboard's `process_update` publishes session metadata and is ignored at both tool start and tool end, preventing duplicate progress in the footer and editor-above HUD. Set `toolActivityMode` via `/statusline` or `statusline.json`.

Auxiliary model usage is owned by the Auxiliary package. It remains in branch-local `terrific-pi:auxiliary-usage-v1` entries and, when `auxiliary.usageReports` is enabled, appears as per-call notifications plus one settled-turn aggregate. Statusline `tokens` and `cost` always represent the main session only. Legacy `auxUsage` widget ids in old configs are ignored.

### Quota eligibility (strict)

`quota` is shown only when **all** of the following hold:

1. `quota` is present in any configured line
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

- **Widgets**: partitioned by `LINE0`-`LINE4`; `Space` toggles, `g` cycles the selected widget through lines, Up/Down selects, Left/Right reorders across line boundaries, Enter finishes. Any widget can occupy any line.
- **Appearance**: icon mode, separator, spacing, **Minimal profile**
- **Context & usage**: contextMode, contextBarWidth (only if `contextBar` enabled), toolActivityMode (only if `toolActivity` enabled)
- **Run notification**: one direct on/off toggle; independent from the `run*` widgets
- show / reload / confirmed reset config
- enum menus put the current value first and mark current/default values; numeric inputs are prefilled

Each successful change is atomically written to the config file and the footer refreshes. Invalid JSON is reported and is not overwritten by ordinary menu changes; use a successful reload or confirmed reset to clear that state.

### Data scope and refresh

| data | source and scope |
|------|------------------|
| path, model, context | live pi context; unavailable context renders as `🪟 ?` in emoji mode |
| tokens, cache, cost | main assistant usage entries on the active session branch; refreshed after assistant completion and branch/tree changes |
| branch | pi footer data; branch diff is local Git committed-line data only and excludes the working tree |
| mode, fast, progress | pi extension status map; dedicated mode/fast/ponytail statuses are excluded from progress, and terminal controls are removed |
| duration, tools, environment | process-local event data; tool counts reset per agent run and are not restored from session history |
| run metrics / notification | one process-local snapshot produced at `agent_settled`; cleared at the next agent run and not restored from session history |
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

## Ownership and attribution

`statusline` remains the only production `setFooter()` owner. Every widget, including `worktree`, `runtime`, and the six `run*` metrics, is an ordinary independently placed/toggled unit in `LINE0`-`LINE4`. Appearance supplies the editor surfaces used by `LINE0` and `LINE1`; statusline does not claim header/editor/transcript ownership. Derived Open TUI portions are attributed in `LICENSES/pi-open-tui-MIT.txt`.

## Develop

```bash
cd packages/interface/statusline
npm test
```
