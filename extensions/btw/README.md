# btw

Pi `/btw` one-shot side-channel Q&A over an isolated in-memory session. It does not write the main conversation or load tools, extensions, skills, prompts, or persistent session state.

## Install

```text
../vendor/terrific-pi/extensions/btw
```

## Configure

File: `~/.pi/agent/pi-essentials.json`.

When `auxiliary.tasks.btw` exists in the global config, `/btw` uses that route's model, thinking, timeout, output cap, and fallback models. Snapshot budgeting uses each selected model's actual context window.

```json
{
  "btw": {
    "thinking": "minimal",
    "maxContextTokens": 80000,
    "maxOutputTokens": 2000
  },
  "auxiliary": {
    "tasks": {
      "btw": {
        "model": "openai/gpt-5.4-mini",
        "thinking": "low",
        "timeoutMs": 60000,
        "maxOutputTokens": 2000,
        "fallbackModels": []
      }
    }
  }
}
```

The legacy `btw` block still controls the maximum context snapshot. If the global `auxiliary` config is absent, `/btw` keeps its previous behavior and uses the current main model. Trusted project config may adjust legacy snapshot limits but cannot override the global auxiliary model route.

## Behavior

- `/btw [question]` asks one side question; cancel aborts only the isolated request.
- The snapshot preserves message roles, removes images and excluded messages, and is bounded before the call.
- The overlay shows the actual `provider/model` used.
- Each attempt emits a payload-free `terrific-pi:auxiliary-usage-v1` event through the auxiliary bridge.
- Authentication is resolved from Pi's model registry into an in-memory credential store; `auth.json` is not read by the sidecar.
- Print/JSON modes return an explicit unsupported-mode error without calling a model.

## Verify

```bash
npm run check
```
