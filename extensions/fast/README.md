# fast

Toggle OpenAI [Priority processing](https://platform.openai.com/docs/guides/priority-processing) for [pi](https://pi.dev).

Injects `service_tier: "priority"` into Responses / Codex Responses requests. Footer shows the single-column bolt `` when enabled.

## Usage

```text
/fast          toggle
/fast on       enable
/fast off      disable
```

## Scope

| API | Support |
|-----|---------|
| `openai-responses` | yes |
| `openai-codex-responses` | yes |
| `azure-openai-responses` | injected (provider-dependent) |
| other | no-op (warning if `/fast on`) |

Notes:

- Not a thinking-level control (`Shift+Tab` / `/thinking` is separate)
- Priority pricing is roughly 2× standard (gpt-5.5 ~2.5× in pi-ai accounting)
- Session-local only (off after restart)

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
