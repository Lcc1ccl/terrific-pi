# btw

Pi `/btw` one-shot side-channel Q&A over an isolated in-memory session. It does not write the main conversation or load tools, extensions, skills, prompts, or persistent session state.

## Install

Install the `terrific-pi` root package:

```bash
pi install /path/to/terrific-pi
```

## Configure

File: `~/.pi/agent/terrific.json`.

When `auxiliary.tasks.btw` exists in the global config, `/btw` uses that route's model, thinking, timeout, output cap, and fallback models. Set `useAuxiliary` to `false` to use the current main model without deleting the saved BTW model or fallbacks. Snapshot budgeting uses each selected model's actual context window.

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
        "useAuxiliary": true,
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

## Commands

- `/btw [question]` asks one side question with a bounded snapshot of the current session.
- `/btw context=none [question]` makes a one-shot question without main-session context.
- `/btw status` prints the effective route, fallbacks, timeout, output cap, context budget, and config paths.
- `/btw config` edits only `btw.maxContextTokens` in global or trusted-project scope and labels the selected write target separately from the effective value/source paths; Auxiliary route fields remain under `/aux config -> btw`.

## Behavior

- Cancel aborts only the isolated request.
- Each auxiliary candidate uses one wall-clock deadline covering authentication, runtime/session creation, prompting, and cleanup. Timeout or cancellation stops waiting even when an underlying provider ignores abort; a session that resolves late is disposed.
- The snapshot preserves message roles, removes images and excluded messages, and is bounded before the call.
- The overlay shows the actual `provider/model` used.
- Each attempt emits a payload-free `terrific-pi:auxiliary-usage-v1` event through the auxiliary bridge.
- Authentication is resolved from Pi's model registry into an in-memory credential store; `auth.json` is not read by the sidecar.
- Print/JSON modes return an explicit unsupported-mode error without calling a model.

## Verify

```bash
npm run check
```
