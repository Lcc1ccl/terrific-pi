# model-profile

Short-list **model + thinking** switcher for [pi](https://pi.dev).

For long registries and many providers: keep 3–5 named profiles and switch them without browsing the full `/model` list. Does **not** replace `/model` / `Ctrl+L`.

| Scope | Status | Behavior |
|-------|--------|----------|
| session | ✅ | Switch session model/thinking, then **restore** the exact prior `settings.json` contents after Pi finishes its queued write |
| global | ✅ | session apply + keep/update `settings.json` defaults |
| startup picker | ✅ | cold-start + `/new` short list when `modelProfile.startup: true` |

## Install

Install the `terrific-pi` root package, then `/reload` or restart Pi:

```bash
pi install /path/to/terrific-pi
```

## Configure

**Config file:** `~/.pi/agent/terrific.json`（本仓插件统一配置）。  
Trusted project `.pi/terrific.json` can override a global profile by id. In a trusted project, `/profile` → **Project overrides** persists only that profile id plus the edited model pair and/or thinking field, so alias, hotkey, profile CRUD, and startup settings continue to inherit globally. **Reset project override** removes those project fields.

```json
{
  "modelProfile": {
    "startup": true,
    "startupScope": "session",
    "openHotkey": "ctrl+alt+l",
    "profiles": [
      {
        "id": 1,
        "alias": "solm",
        "provider": "openai",
        "model": "gpt-5.6-sol",
        "thinking": "medium"
      }
    ]
  }
}
```

See `examples/config.json`.

| Field | Meaning |
|-------|---------|
| `startup` | Show short-list picker on cold start and `/new` |
| `startupScope` | Preferred scope order on startup (`session` safer) |
| `openHotkey` | Open interactive picker (default `ctrl+alt+l`) |
| `profiles[]` | Numeric `id` (1…), `alias`, `provider`, `model`, `thinking`; optional `hotkey` |
| `alias` | Command key for `/profile <alias>` and the name shown in list/status |
| default hotkey | id `N` (1–9) → `alt+N` unless `hotkey` is set |
| omitted `alias` | id `1` falls back to `default`; aliases do not affect startup order |
| delete renumber | TUI delete compacts remaining ids to `1…n` and shifts project overrides accordingly |
| hotkey order | **Manage profiles → Hotkey order** shows every profile; Up/Down selects, Left/Right reorders, Enter saves and rewrites positions as `id=1…n` + `alt+1…9` |

## Commands

| Command | Behavior |
|---------|----------|
| `/profile` | TUI manager: Quick apply, create from the current session or any available model, edit/delete profiles, startup/shortcut settings, effective summary |
| `/profile list` | Print profiles + startup flag (`*` = match) |
| `/profile status` | Current model/thinking, match, startup flag |
| `/profile startup [on\|off]` | Persist startup flag into `terrific.json` |
| `/profile <id\|alias>` | **Session** apply |
| `/profile <id\|alias> session\|global` | Apply with explicit scope |
| `/profile help` | Usage + caveats |

Quick apply keeps the short-list profile picker and `session` / `global` scope choice as the first manager action. **Create profile** can either capture the live session or browse an available model and choose its supported thinking level before saving; it does not activate the new profile. The picker shows `Up/Down` navigate, `Enter` select/activate, and `Esc` action tips: `Esc` cancels from the profile list, while `Esc` on scope returns to the profile list. The manager's effective summary reports the global/project source for every profile. `alt+N` always **session** apply (works with draft text). The extension pre-registers `alt+1` through `alt+9` and reads their target from the latest `terrific.json`, so newly created default-numbered profiles and Hotkey order changes work immediately in the current session. A newly entered non-default custom binding still requires **`/reload`** because Pi exposes no shortcut unregister/refresh API after the TUI snapshots extension shortcuts.

## Session vs global vs official /model

| Path | Session model | `settings.json` defaults |
|------|---------------|---------------------------|
| `/profile …` / `alt+N` (session) | changes | **restored** after switch |
| `/profile … global` | changes | **updated** |
| Official `/model`, `Ctrl+P`, `Ctrl+L` | changes | **updated** (pi core; not wrapped) |

If you need sticky defaults, prefer `/profile` over official model cycling.

## Official picker tip

When you switch via **official** `/model`, `Ctrl+L`, `Ctrl+P` cycle, or thinking keys, pi updates `settings.json` defaults. This extension shows a **warning notify**, e.g.:

```text
Switched via official picker: settings defaults updated to openai/gpt-5.6-luna (pi core). Use /profile for session-only.
```

Switches done through `/profile` / `alt+N` / startup picker **do not** show that tip (session path restores defaults; global path is intentional).

## Startup matrix

| Condition | Behavior |
|-----------|----------|
| `session_start.reason` is `startup` or **`new`**, `startup: true`, TUI | Short-list picker |
| `resume` / `fork` / `reload` | No picker |
| List order | **Keep global default** on cold start / **Keep current session** on `/new` (first) → configured profiles → **Turn off future startup picker** → **`0 · Browse all models…`** (last) |
| Turn off future startup picker | Persist `startup: false`, remove the toggle from the current list, and keep the current picker open so this session can still choose a model |
| Keep current · cold start | Keep Pi's activated global default model/thinking |
| Keep current · `/new` | Restore the previous session model/thinking and the original `settings.json` contents |
| Navigation | Up/down wraps at both ends; `0` opens Browse, `1`–`9` immediately select the matching profile id |
| Browse all models | Provider → fuzzy-searchable model list by partial ID/ref/name (`5.6`, `sol`, etc.) → supported thinking level → session/global scope |

## Verify

```bash
npm install
npm run check
```

## Plan

`docs/plans/2026-07-20-model-profile-plan.md` in the terrific-pi repo root.
