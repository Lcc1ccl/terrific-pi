# fast

Toggle OpenAI [Priority processing](https://platform.openai.com/docs/guides/priority-processing) for [pi](https://pi.dev).

Injects `service_tier: "priority"` into Responses / Codex Responses requests. Footer / statusline shows the bolt `` only while fast is **active**.

## Usage

```text
/fast          toggle
/fast on       enable
/fast off      disable
```

## Behavior

| Concern | Rule |
|---------|------|
| Preference | Global, persisted in `~/.pi/agent/terrific.json` as `fast.enabled` |
| Active (badge) | Preference ON **and** current model API is openai-family Responses |
| Non-openai model | Auto-yield: no injection, badge hidden; preference kept |
| Back to openai | Preference re-applies automatically |
| Legacy session `fast-state` | Migrated once into global config when `fast` key is absent |
| Config writes | Locked merge into `terrific.json` (same lock file as other writers) |

### Supported APIs

| API | Support |
|-----|---------|
| `openai-responses` | yes |
| `openai-codex-responses` | yes |
| `azure-openai-responses` | injected (provider-dependent) |
| other | inactive (preference may still be ON) |

Notes:

- Not a thinking-level control (`Shift+Tab` / `/thinking` is separate)
- Priority pricing is roughly 2× standard (gpt-5.5 ~2.5× in pi-ai accounting)
- Injects into the outbound request body only; third-party proxies must forward `service_tier` for real Priority processing
- Status badge reflects **active** state (preference ∩ openai-family), not raw preference alone

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
