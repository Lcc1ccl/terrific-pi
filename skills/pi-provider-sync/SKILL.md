---
name: pi-provider-sync
description: Use when adding or updating a custom pi provider from an OpenAI-compatible or Anthropic-messages endpoint, syncing available models into ~/.pi/agent/models.json, refreshing a proxy model list, configuring model vision/input/reasoning/maxTokens/cost fields, fixing missing statusline cost ($0), auditing missing official models.json fields, or when the user says add provider, sync models, pull models from endpoint, rewrite models.json from /models, refresh provider config, or fill cost pricing.
---

# Pi Provider Sync

Sync a custom pi provider from its live `/models` endpoint into `~/.pi/agent/models.json`. Write **all** available models with complete official fields (including `cost` when known), then let the user choose which one to enable.

Primary docs / sources (read when unsure):
- pi package: `docs/models.md` (custom models / provider fields)
- Runtime catalog cache: `~/.pi/agent/models-store.json` (often OpenAI-only)
- Built-in pi-ai catalogs: the active `pi` installation's `pi-ai/dist/providers/data/{xai,anthropic,openai,openai-codex,google}.json` (legacy `.models.js` fallback)

## When to Use

- Add a new custom provider (proxy / gateway / OpenAI-compatible / Anthropic-messages base URL)
- Refresh an existing provider's model list from the endpoint
- User asks to pull models, rewrite `models.json`, or configure provider from API
- Fix vision / image-read failures caused by missing `input: ["text","image"]`
- Fix missing statusline / footer **cost** (`$0` / blank) after proxy sync
- Audit whether `models.json` is missing official fields

## Do Not

- Hardcode API keys into `models.json` (use `~/.pi/agent/auth.json` or `/login`)
- Change `defaultModel` / `defaultProvider` unless the user explicitly asks
- Delete other providers already present in `models.json`
- Skip backup before overwrite
- **Invent `cost` numbers** (proxy markups, guesses, or “close enough” prices)
- Blindly copy official transport `baseUrl` / full `compat` onto a third-party proxy that already works with a different `api`

## Required Inputs

Collect missing values before writing:

| Input | Example | Notes |
|-------|---------|-------|
| `provider` | `grok` / `openai` / `anthropic` | Key used in `models.json` + `auth.json` |
| `baseUrl` | `https://api.example.com/v1` | See baseUrl rules by `api` below |
| `api` | `openai-responses` | Or `openai-completions` / `anthropic-messages` |
| `apiKey` | `sk-...` | From user or existing `auth.json` |
| `provider name` | `Grok` | Optional display name |

If only "refresh current provider" is asked, read provider/`baseUrl` from existing `models.json` and key from `auth.json`.

If multiple providers share one gateway but different keys (e.g. `grok` + `openai` + `anthropic` on the same host), **sync each provider separately** with its own auth key. Endpoint model lists are often key-scoped.

## Workflow

1. **Read current config**
   - `~/.pi/agent/models.json`
   - `~/.pi/agent/auth.json`
   - `~/.pi/agent/settings.json` (for current default only; do not change unless asked)

   pi accepts JSONC here: `//` comments and trailing commas are valid input. The script reads both, rejects non-standard `NaN`/`Infinity` values, then writes canonical JSON only when it changes the file.

2. **Fetch models**
   - Prefer the skill script (handles backup/merge/heuristics/cost):

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
   - Re-enrich existing models only (no network fetch): `--enrich-only` (uses the existing provider `api`/`baseUrl`; omit `--api` and `--base-url`)
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

4. **Model entry defaults** (see field guide + cost section)
   - Always set: `id`, `name`, `contextWindow`, `reasoning`, `input`, `maxTokens` when resolvable
   - Enrichment priority: endpoint field → newer matching-provider `models-store.json` entry → active pi-ai catalog → known aliases/built-ins → family heuristic → safe fallback
   - `input`: vision-capable chat models get `["text","image"]`; audio/video/realtime stay `["text"]`
   - `reasoning` + `thinkingLevelMap`: endpoint flags/maps → newer matching-provider store entry → active pi catalog → known aliases/built-ins → id markers
   - `cost`: copy only complete four-rate values from the selected store/catalog source; never invent
   - `compat`: only native Anthropic compatibility flags when using `anthropic-messages`; never guess proxy flags

5. **Hand off to user**
   - Print the full model id list + vision/reasoning/**cost** summary
   - Keep current default unless user picks one
   - Tell user: current session must `/model` re-select (or restart) before new fields take effect
   - Optional: set `settings.json` `defaultModel` / `defaultProvider` only if asked

## Cost configuration (important)

### Why cost is missing

Symptom:
- statusline / footer shows `$0` or no cost
- `models.json` model entries lack `"cost": { ... }`

Root causes (verified):

1. Proxy `/models` almost never returns pricing.
2. `~/.pi/agent/models-store.json` is often **OpenAI-only**. Custom `grok` / `anthropic` providers then get **zero** store hits for cost.
3. Older sync logic only copied cost from the store, so xAI/Claude stayed empty even when pi-ai official catalogs had prices.
4. Id mismatch: endpoint ids like `grok-4.5-latest` / `grok-build` need alias → official `grok-4.5` / `grok-build-0.1`.
5. Some proxy-only ids (`grok-4.20*`, `composer*`, `imagine*`, custom codenames) have **no official price**. Leaving cost unset is correct; UI falls back to zeros.

### Cost object shape

```json
"cost": {
  "input": 2.0,
  "output": 6.0,
  "cacheRead": 0.5,
  "cacheWrite": 0.0
}
```

Units follow pi/docs: **USD per 1M tokens** (same as built-in providers). pi requires all four base rates (`input`, `output`, `cacheRead`, `cacheWrite`); incomplete or non-finite catalog/store objects are omitted rather than written. Optional tiered costs may appear on some OpenAI models (`tiers`); copy the complete object when present.

### Enrichment priority for `cost`

1. A newer matching-provider `models-store.json` entry, when its `lastModified` is later than the active local catalog file (same precedence as pi runtime)
2. **Active pi-ai catalog** (`dist/providers/data/xai.json`, `anthropic.json`, `openai.json`, …) via exact id or alias/variant
3. Explicit alias map in the script (`grok-4.5-latest` → `grok-4.5`, …)
4. **Stop**. Do not invent, do not scale by proxy markup, do not copy “similar model” prices unless the selected catalog itself aliases them

### Alias / variant matching

Always try, in order:

1. exact endpoint `id`
2. script `KNOWN_ID_ALIASES`
3. strip trailing `YYYY-MM-DD`
4. strip trailing `-latest`

Examples:

| Endpoint id | Official cost source |
|-------------|----------------------|
| `grok-4.5` | `data/xai.json` → `grok-4.5` |
| `grok-4.5-latest` | alias → `grok-4.5` |
| `grok-build` / `grok-build-latest` | alias → `grok-build-0.1` |
| `claude-haiku-4-5-20251001` | date strip / exact anthropic catalog |
| `claude-sonnet-5` | anthropic catalog |
| `gpt-5.4` | models-store / openai catalog |

### Reporting after sync

Script prints:

- `with_cost=N` / `no_cost=M`
- ids missing cost

Tell the user clearly:
- missing cost means **no official rate**, not a broken statusline
- proxy billing may differ from official USD rates; cost is **estimate for UI**, not invoice truth

### Re-enrich without refetch

When models already exist and only derived fields such as cost/context need repair:

```bash
python3 ~/.agents/skills/pi-provider-sync/sync_provider_models.py \
  --provider grok \
  --enrich-only
```

`--enrich-only` does not fetch or change provider transport settings. It refreshes derived fields from store + pi-ai catalogs while preserving model-level `api`, `baseUrl`, `compat`, `cost`, `thinkingLevelMap`, and custom metadata. Existing complete model-level `cost` and `thinkingLevelMap` are treated as user overrides; legacy input/output-only costs are normalized with zero cache rates so pi can load the file.

## Official Field Guide (`docs/models.md`)

### Provider-level

| Field | Required? | Practice |
|-------|-----------|----------|
| `baseUrl` | yes for custom | See baseUrl rules by API |
| `api` | yes for custom | Prefer proven working transport |
| `models` | yes when defining catalog | Full list from endpoint |
| `name` | no | Display name |
| `apiKey` | no | Prefer `auth.json`; never put secrets in models.json |
| `headers` / `authHeader` / `oauth` | no | Only for special gateways |
| `compat` | no | Provider-wide quirks |
| `modelOverrides` | no | Patch built-ins without replacing full list |

Normal sync replaces only the target provider's `name`, `baseUrl`, `api`, and `models`; it retains all other provider-level fields, including `oauth`, `modelOverrides`, and gateway-specific metadata.

### Model-level

| Field | Required? | Default if omitted | Practice |
|-------|-----------|--------------------|----------|
| `id` | **yes** | — | Endpoint model id, passed to API |
| `name` | no | `id` | Prefer `display_name` / official name |
| `api` | no | provider `api` | Per-model override only if needed |
| `reasoning` | no | `false` | Detect from endpoint / official / id |
| `thinkingLevelMap` | no | omitted | Set when `reasoning: true` |
| `input` | no | `["text"]` | **Must set for vision models** |
| `contextWindow` | no | `128000` | Prefer official windows |
| `maxTokens` | no | `16384` | Prefer official / store |
| `cost` | no | all zeros in UI | **Copy complete store/catalog values only** |
| `compat` | no | provider compat | Adaptive thinking flags for native Claude |

### Intentionally omit unless needed

- Secrets (`apiKey` in models.json)
- Guessed `cost`
- Full official `baseUrl`/`api` copied onto a proxy that uses a different transport
- `modelOverrides` when you already own the full custom `models` list

## baseUrl + API rules

| `api` | Written `baseUrl` | Why |
|-------|-------------------|-----|
| `openai-responses` / `openai-completions` | usually `https://host/v1` | Client paths are relative to `/v1` |
| `anthropic-messages` | `https://host` **without** trailing `/v1` | Anthropic SDK always calls `{baseUrl}/v1/messages`. If base already ends with `/v1`, requests become `/v1/v1/messages` → 404 |

Script auto-strips trailing `/v1` when `--api anthropic-messages`.

Live-check before writing Anthropic native:

```bash
# should be 200
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "x-api-key: $KEY" -H "Authorization: Bearer $KEY" \
  -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  --data '{"model":"<id>","max_tokens":16,"messages":[{"role":"user","content":"ping"}]}' \
  https://host/v1/messages
```

For adaptive Claude models (`claude-fable-5`, `claude-opus-4-6/4-7/4-8`, `claude-sonnet-4-6/5`), copy official:

```json
"compat": { "forceAdaptiveThinking": true }
```

(and `supportsTemperature: false` when the official catalog has it). For a native Messages proxy that rejects per-tool `eager_input_streaming`, set `compat.supportsEagerToolInputStreaming: false`; for a proxy that cannot accept deferred `tool_reference` blocks, set `compat.supportsToolReferences: false`. The script copies only recognized native flags reported by the selected catalog or endpoint and never assumes either proxy quirk.

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
- Keep audio / realtime / pure video models as `["text"]`
- After rewrite, user must `/model` again or restart session

## Enrichment Sources

Priority when filling a field:

1. Live `/models` item fields (`display_name`, `input`, reasoning flags/maps, context keys)
2. A newer matching-provider `~/.pi/agent/models-store.json` entry; pi ignores it when `lastModified` is not newer than the active local catalog file
3. **Active pi-ai catalogs** (`xai` / `anthropic` / `openai` / … `data/*.json`, with legacy module fallback) — source for **cost**, context, maxTokens, and native compat
4. Built-in alias / known maps in the script
5. Family heuristics
6. Safe fallback (`contextWindow=256000`, **no invented cost**)

### Reasoning detection

Mark `reasoning: true` when any of:
- id contains `reasoning` / `think` / `multi-agent` (but not `non-reasoning`)
- endpoint has `supportsReasoningEffort: true` or `reasoningEfforts`
- family markers: `grok-4*`, `grok-build*`, `gpt-5*`, `o1/o3/o4`, `claude-opus/sonnet/haiku/fable`, modern Gemini reasoning families
- official/store entry says `reasoning: true`

Force `reasoning: false` for image/video/imagine-style generation ids.

### Default thinkingLevelMap

Use when endpoint/store/official give nothing better:

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

Prefer official maps when present (OpenAI often uses `"off": "none"`; some Claude adaptive models only expose `max` / `xhigh`).

### Context window heuristics (fallback only)

| Family | Typical window |
|--------|----------------|
| modern Claude adaptive / sonnet-5 / opus-4.6+ | 1000000 |
| Claude haiku / older opus-4.5 | 200000 |
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
| OpenAI Codex Responses-compatible endpoint | `openai-codex-responses` |
| Anthropic Messages-compatible proxy (native) | `anthropic-messages` |
| Google Generative AI endpoint | `google-generative-ai` |

If a gateway exposes Claude on both OpenAI-compat and native Messages, prefer the transport the user asks for. Native Messages needs correct baseUrl + adaptive `compat`.

If unsure and current provider already works, keep its existing `api`.

## Verification

```bash
python3 -m json.tool ~/.pi/agent/models.json >/dev/null
python3 ~/.agents/skills/pi-provider-sync/sync_provider_models.py \
  --provider <provider> --base-url <baseUrl> --api <api> --dry-run
```

Confirm:
- Target provider exists with expected `baseUrl` / `api`
- Model count matches endpoint
- Other providers still present
- No API key leaked into `models.json`
- Target chat models have `"input": ["text", "image"]` when vision is expected
- Reasoning models have `thinkingLevelMap`
- Cost present for ids that exist in official catalogs; missing cost explained, not faked
- For `anthropic-messages`, baseUrl does **not** end with `/v1`
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
    cost=sum(1 for m in models if isinstance(m.get('cost'), dict))
    print(prov, 'api=', cfg.get('api'), 'base=', cfg.get('baseUrl'),
          'models', len(models), 'vision', vision,
          'reasoning', sum(1 for m in models if m.get('reasoning')),
          'cost', cost)
    missing=[m['id'] for m in models if not m.get('cost')]
    if missing:
        print('  no-cost:', ', '.join(missing))
PY
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Wrote key into `models.json` | Move to `auth.json`; strip from models file |
| Overwrote entire `models.json` | Merge under `providers.<name>` only |
| Changed default without asking | Revert `settings.json`; only list options |
| OpenAI-compat base without needed `/v1` | Match working client URL; re-fetch |
| Anthropic native base ends with `/v1` | Strip to host root; SDK adds `/v1/messages` |
| Empty model list | Check auth, key-scoped catalog, URL path, raw `/models` body |
| Missing `input` on vision models | Set `["text","image"]` |
| Synced one provider key for a multi-key gateway | Sync each provider with its own key |
| Expected `read` to return OCR text | Normal: tool attaches image; model vision interprets it |
| Invented proxy cost to “fill zeros” | Leave unset or copy official only |
| Assumed `models-store.json` covers grok/claude | Load pi-ai catalogs; store may be OpenAI-only |
| Assumed config hot-applies to current model object | Tell user to `/model` re-select or restart |

## Script flags

Run `python3 ~/.agents/skills/pi-provider-sync/sync_provider_models.py --help` for full flags.

Key flags:
- `--dry-run`: fetch + print plan, no write
- `--write-auth` + `--api-key`: also store provider key in `auth.json`
- `--api`: pi transport type; defaults to `openai-responses` for normal sync
- `--enrich-only`: re-enrich existing provider models (cost/context/etc.) without `/models` fetch; preserves provider transport and model-level configuration, so omit `--api` and `--base-url`
- `--context-window`: fallback only when no better signal exists

## Local layout

```
~/.agents/skills/pi-provider-sync/
  SKILL.md
  sync_provider_models.py
```

Repo mirror (terrific-pi): `skills/pi-provider-sync/` — keep both copies aligned when editing.

Related runtime files:
- `~/.pi/agent/models.json` — custom providers/models
- `~/.pi/agent/auth.json` — secrets
- `~/.pi/agent/settings.json` — defaults (`defaultProvider` / `defaultModel`)
- `~/.pi/agent/models-store.json` — runtime catalog cache (often partial)
- Active pi-ai `dist/providers/data/*.json` — official cost/context source of truth; the script resolves the running `pi` executable first, then falls back to the newest installed catalog
