# fast

Toggle OpenAI [Priority processing](https://platform.openai.com/docs/guides/priority-processing) for [pi](https://pi.dev).

Injects `service_tier: "priority"` into Responses / Codex Responses requests. Footer / statusline shows the bolt `` only while fast is **active**.

## Usage

```text
/fast          toggle
/fast on       enable
/fast off      disable
/fast status   show preference, effective state, current API/model, and config path
```

## Behavior

| Concern | Rule |
|---------|------|
| Preference | Global, persisted in `~/.pi/agent/terrific.json` as `fast.enabled` |
| Active (badge) | Preference ON **and** model id is GPT **and** API is openai-family Responses |
| Non-GPT model (e.g. grok/claude/codex) | Auto-yield: no injection, badge hidden; preference kept |
| Non-openai or unknown API | Auto-yield |
| Model switch (incl. `/profile` browse) | `model_select` updates badge immediately; inject follows live model |
| Back to GPT + supported API | Preference re-applies automatically |
| Legacy session `fast-state` | Migrated once into global config when `fast` key is absent |
| Config writes | Locked merge into `terrific.json` (same lock file as other writers); write failure leaves the current preference unchanged |
| External edits | `fast.enabled` is reread before each request and provider payload |

### Supported models

| Check | Rule |
|-------|------|
| Model id | **GPT only**: `gpt`, `gpt-*`, `gpt.*` (case-insensitive) |
| Examples active | `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-4o`, `GPT-5.2` |
| Examples inactive | `grok-4.5`, `claude-opus-4`, `codex-auto-review`, `o3-mini` |

### Supported APIs

| API | Support |
|-----|---------|
| `openai-responses` | yes (with GPT model id) |
| `openai-codex-responses` | yes (with GPT model id) |
| `azure-openai-responses` | injected when model id is GPT (provider-dependent) |
| other | inactive (preference may still be ON) |

Notes:

- Not a thinking-level control (`Shift+Tab` / `/thinking` is separate)
- Priority pricing is roughly 2× standard (gpt-5.5 ~2.5× in pi-ai accounting)
- Injects into the outbound request body only; third-party proxies must forward `service_tier` for real Priority processing
- Status badge reflects **active** state (preference ∩ GPT id ∩ openai-family API), not raw preference alone

## Config

```json
{
  "fast": {
    "enabled": true
  }
}
```

File: `~/.pi/agent/terrific.json` (shared with other terrific-pi plugins).

## Install

```bash
pi install /path/to/terrific-pi/extensions/fast
```

Local path used by this repo:

```json
{
  "packages": [
    "../vendor/terrific-pi/extensions/fast"
  ]
}
```
