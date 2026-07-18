---
name: pi-provider-sync
description: Use when adding or updating a custom pi provider from an OpenAI-compatible endpoint, syncing available models into ~/.pi/agent/models.json, refreshing a proxy model list, configuring model vision/input/reasoning/maxTokens fields, auditing missing official models.json fields, or when the user says add provider, sync models, pull models from endpoint, rewrite models.json from /models, or refresh provider config.
---

# Pi Provider Sync

Sync a custom pi provider from its live `/models` endpoint into `~/.pi/agent/models.json`. Write **all** available models with complete official fields, then let the user choose which one to enable.

Primary docs (read when unsure):
- pi package: `docs/models.md` (custom models / provider fields)
- Runtime catalog cache: `~/.pi/agent/models-store.json`
- Built-in xAI metadata: pi-ai `providers/xai.models.js`

## When to Use

- Add a new custom provider (proxy / gateway / OpenAI-compatible base URL)
- Refresh an existing provider's model list from the endpoint
- User asks to pull models, rewrite `models.json`, or configure provider from API
- Fix vision / image-read failures caused by missing `input: ["text","image"]`
- Audit whether `models.json` is missing official fields

## Do Not

- Hardcode API keys into `models.json` (use `~/.pi/agent/auth.json` or `/login`)
- Change `defaultModel` / `defaultProvider` unless the user explicitly asks
- Delete other providers already present in `models.json`
- Skip backup before overwrite
- Invent `cost` numbers
- Blindly copy official `xai` / `openai.com` `compat` onto third-party proxies that already work

## Required Inputs

Collect missing values before writing:

| Input | Example | Notes |
|-------|---------|-------|
| `provider` | `grok` | Key used in `models.json` + `auth.json` |
| `baseUrl` | `https://api.example.com/v1` | Must include `/v1` if the server uses it |
| `api` | `openai-responses` | Common: `openai-responses`, `openai-completions` |
| `apiKey` | `sk-...` | From user or existing `auth.json` |
| `provider name` | `Grok` | Optional display name |

If only "refresh current provider" is asked, read provider/`baseUrl` from existing `models.json` and key from `auth.json`.

If multiple providers share one gateway but different keys (e.g. `grok` + `openai` both on `api.example.com/v1`), **sync each provider separately** with its own auth key. Endpoint model lists are often key-scoped.

## Workflow

1. **Read current config**
   - `~/.pi/agent/models.json`
   - `~/.pi/agent/auth.json`
   - `~/.pi/agent/settings.json` (for current default only; do not change unless asked)

2. **Fetch models**
   - Prefer the skill script (handles backup/merge/heuristics):

```bash
python3 ~/.agents/skills/pi-provider-sync/sync_provider_models.py \
  --provider <provider> \
  --base-url <baseUrl> \
  --api <api> \
  --api-key <key-if-needed> \
  --provider-name "<Name>"
```

   - Dry-run first when user wants preview only: add `--dry-run`
   - New provider key storage: add `--write-auth` **and** `--api-key`
   - Multi-provider refresh: run the script once per provider key
   - Manual fallback:

```bash
curl -sS -H "Authorization: Bearer $KEY" "$BASE_URL/models"
```

3. **Write rules**
   - Upsert only the target provider under `providers`
   - Replace that provider's `models` array with the full endpoint list
   - Keep other providers untouched
   - Backup `models.json` before write (script does this automatically)
   - Secrets stay in `auth.json`, not `models.json`

4. **Model entry defaults** (see field guide below)
   - Always set: `id`, `name`, `contextWindow`, `reasoning`, `input`, `maxTokens` when resolvable
   - Enrichment priority: endpoint field → `models-store.json` → known built-ins → family heuristic → safe fallback
   - `input`: vision-capable chat models get `["text","image"]`; audio/video/realtime stay `["text"]`
   - `reasoning` + `thinkingLevelMap`: endpoint flags / store / id markers
   - `cost`: copy from store only; never invent
   - `compat`: omit unless the proxy needs it

5. **Hand off to user**
   - Print the full model id list + vision/reasoning summary
   - Keep current default unless user picks one
   - Tell user: current session must `/model` re-select (or restart) before new `input`/vision takes effect
   - Optional: set `settings.json` `defaultModel` / `defaultProvider` only if asked

## Official Field Guide (`docs/models.md`)

### Provider-level

| Field | Required? | Practice |
|-------|-----------|----------|
| `baseUrl` | yes for custom | Keep working client URL, usually ends with `/v1` |
| `api` | yes for custom | Prefer existing working value; see API quick pick |
| `models` | yes when defining catalog | Full list from endpoint |
| `name` | no | Display name |
| `apiKey` | no | Prefer `auth.json`; do **not** put secrets in models.json |
| `headers` / `authHeader` / `oauth` | no | Only for special gateways |
| `compat` | no | Provider-wide OpenAI/Anthropic quirks |
| `modelOverrides` | no | Patch built-ins without replacing full list |

### Model-level

| Field | Required? | Default if omitted | Practice |
|-------|-----------|--------------------|----------|
| `id` | **yes** | — | Endpoint model id, passed to API |
| `name` | no | `id` | Prefer `display_name` from endpoint |
| `api` | no | provider `api` | Set only for per-model override |
| `reasoning` | no | `false` | Detect from endpoint / store / id |
| `thinkingLevelMap` | no | omitted | Set when `reasoning: true` |
| `input` | no | `["text"]` | **Must set for vision models** or images are stripped |
| `contextWindow` | no | `128000` | Prefer real windows; do not blanket huge values |
| `maxTokens` | no | `16384` | Prefer store/built-in; GPT-5.x often `128000` |
| `cost` | no | all zeros | Copy official only |
| `compat` | no | provider compat | Only when proxy needs quirks |

### Intentionally omit unless needed

- Secrets (`apiKey` in models.json)
- Guessed `cost`
- Official-provider `compat` copied onto a third-party proxy that already works
- `modelOverrides` when you already own the full custom `models` list

## Vision / Image Experience (important)

Symptom:
- `read` can open png/jpg paths
- Tool text only says `Read image file [image/png]`
- Model note: `Current model does not support images. The image will be omitted from this request.`

Root cause chain:
1. pi `read` attaches binary image content; it does **not** OCR into text
2. Whether the model receives that attachment depends on `model.input` including `"image"`
3. Official default is `["text"]` when `input` is missing
4. Many proxy `/models` payloads do **not** advertise vision; you must infer/enrich

Resolution:
- Set vision chat models to `"input": ["text", "image"]`
- Keep audio / realtime / pure video models as `["text"]` (pi has no audio input type)
- Image gen/edit ids (`gpt-image-*`, `grok-imagine*`) may still use `["text","image"]` for edit-style attachments
- After rewrite, user must `/model` again or restart session

## Enrichment Sources

Priority when filling a field:

1. Live `/models` item fields (`display_name`, `supportsReasoningEffort`, `reasoningEfforts`, context keys)
2. `~/.pi/agent/models-store.json` exact/base id match (great for OpenAI `input` / `maxTokens` / `cost` / `thinkingLevelMap`)
3. Built-in known maps in the script (xAI `grok-4.3` / `grok-4.5` / `grok-build-0.1`)
4. Family heuristics in the script
5. Safe fallback (`contextWindow=256000`, no invented cost)

### Reasoning detection

Mark `reasoning: true` when any of:
- id contains `reasoning` / `think` / `multi-agent` (but not `non-reasoning`)
- endpoint has `supportsReasoningEffort: true` or `reasoningEfforts`
- family markers: `grok-4*`, `grok-build*`, `gpt-5*`, `o1/o3/o4`, modern Claude/Gemini reasoning families
- store entry says `reasoning: true`

Force `reasoning: false` for image/video/imagine-style generation ids.

### Default thinkingLevelMap

Use when endpoint/store give nothing better:

```json
{
  "off": null,
  "minimal": null,
  "low": "low",
  "medium": "medium",
  "high": "high",
  "xhigh": null,
  "max": null
}
```

Prefer store/official maps when present (example: OpenAI often uses `"off": "none"`; `grok-4.5` official map hides `off`/`minimal` only).

### Context window heuristics (fallback only)

| Family | Typical window |
|--------|----------------|
| `grok-4.5*` | 500000 |
| `grok-4.3*` | 1000000 |
| `grok-build*` / `composer*` / other `grok-4*` | 256000 |
| `gpt-5.4` / `gpt-5.5` / `gpt-5.6` non-pro non-mini | 272000 |
| other `gpt-5*` / many codex | 400000 |
| `*-chat-latest` / `codex-spark` | 128000 |
| imagine / image / video | 32000 |
| audio / realtime | 128000 |

## API type quick pick

| Situation | `api` |
|-----------|-------|
| OpenAI Responses-style proxy | `openai-responses` |
| Classic Chat Completions proxy / most local servers | `openai-completions` |
| Anthropic Messages-compatible proxy | `anthropic-messages` |
| Google Generative AI endpoint | `google-generative-ai` |

If unsure and current provider already works, keep its existing `api`.

## Verification

```bash
python3 -m json.tool ~/.pi/agent/models.json >/dev/null
python3 ~/.agents/skills/pi-provider-sync/sync_provider_models.py \
  --provider <provider> --base-url <baseUrl> --dry-run
```

Confirm:
- Target provider exists with expected `baseUrl` / `api`
- Model count matches endpoint
- Other providers still present
- No API key leaked into `models.json`
- Target chat models have `"input": ["text", "image"]` when vision is expected
- Reasoning models have `thinkingLevelMap`
- `settings.json` defaults unchanged unless requested

Quick audit snippet:

```bash
python3 - <<'PY'
import json
from pathlib import Path
data=json.loads(Path.home().joinpath('.pi/agent/models.json').read_text())
for prov,cfg in data.get('providers',{}).items():
    models=cfg.get('models',[])
    vision=sum(1 for m in models if 'image' in m.get('input',[]))
    print(prov, 'models', len(models), 'vision', vision, 'reasoning', sum(1 for m in models if m.get('reasoning')))
PY
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Wrote key into `models.json` | Move to `auth.json`; strip from models file |
| Overwrote entire `models.json` | Merge under `providers.<name>` only |
| Changed default without asking | Revert `settings.json`; only list options |
| Used base URL without `/v1` | Match working client URL; re-fetch |
| Empty model list | Check auth, URL path, and raw `/models` body |
| Missing `input` on vision models | Set `["text","image"]`; images are otherwise omitted |
| Synced one provider key for a multi-key gateway | Sync each provider with its own key |
| Expected `read` to return OCR text | Normal: tool attaches image; model vision interprets it |
| Copied official xAI `compat` onto working proxy | Leave `compat` out unless requests fail |
| Assumed config hot-applies to current model object | Tell user to `/model` re-select or restart |

## Script flags

Run `python3 ~/.agents/skills/pi-provider-sync/sync_provider_models.py --help` for full flags.

Key flags:
- `--dry-run`: fetch + print plan, no write
- `--write-auth` + `--api-key`: also store provider key in `auth.json`
- `--api`: pi transport type
- `--context-window`: fallback only when no better signal exists

## Local layout

```
~/.agents/skills/pi-provider-sync/
  SKILL.md
  sync_provider_models.py
```

Related runtime files:
- `~/.pi/agent/models.json` — custom providers/models
- `~/.pi/agent/auth.json` — secrets
- `~/.pi/agent/settings.json` — defaults (`defaultProvider` / `defaultModel`)
- `~/.pi/agent/models-store.json` — built-in catalog cache used for enrichment
