# model-profile

Short-list **model + thinking** switcher for [pi](https://pi.dev).

For long registries and many providers: keep 3–5 named profiles and switch them without browsing the full `/model` list. Does **not** replace `/model` / `Ctrl+L`.

| Scope | Status | Behavior |
|-------|--------|----------|
| session | ✅ | Switch session model/thinking, then **restore** previous `settings.json` defaults (pi’s `setModel` always persists otherwise) |
| global | ✅ | session apply + keep/update `settings.json` defaults |
| startup picker | ✅ | cold-start + `/new` short list when `modelProfile.startup: true` |

## Install

```json
"../vendor/terrific-pi/extensions/model-profile"
```

in `~/.pi/agent/settings.json` `packages`, then `/reload` or restart pi.

## Configure

**Config file:** `~/.pi/agent/terrific.json`（本仓插件统一配置）。  
Trusted project `.pi/terrific.json` can override by profile id.

```json
{
  "modelProfile": {
    "startup": true,
    "startupScope": "session",
    "openHotkey": "ctrl+alt+l",
    "profiles": [
      {
        "id": 1,
        "alias": "default",
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
| `profiles[]` | Numeric `id` (1…), `alias`, `provider`, `model`, `thinking`; optional `label`/`hotkey` |
| default hotkey | id `N` (1–9) → `alt+N` unless `hotkey` is set |
| id `1` alias | defaults to `default` when `alias` omitted |

## Commands

| Command | Behavior |
|---------|----------|
| `/profile` | TUI: pick profile → pick `session` / `global` |
| `/profile list` | Print profiles + startup flag (`*` = match) |
| `/profile status` | Current model/thinking, match, startup flag |
| `/profile startup [on\|off]` | Persist startup flag into `terrific.json` |
| `/profile <id\|alias>` | **Session** apply |
| `/profile <id\|alias> session\|global` | Apply with explicit scope |
| `/profile help` | Usage + caveats |

`alt+N` always **session** apply (works with draft text). After editing hotkeys, run **`/reload`**.

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
| List order | **Keep current session** (first) → other profiles → **Browse all models…** (last) |
| Keep current session | Stay on already-activated session model (name shown); matching profile rows omitted |
| Browse all models | Provider → model (`provider/id` labels), then session/global scope |

## Verify

```bash
npm install
npm run check
```

## Plan

`docs/plans/2026-07-20-model-profile-plan.md` in the terrific-pi repo root.
