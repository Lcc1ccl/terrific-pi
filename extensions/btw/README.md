# btw

Pi `/btw` one-shot side-channel Q&A over an isolated in-memory session. It does not write the main conversation or load tools, extensions, skills, prompts, or persistent session state.

## Install

```text
../vendor/terrific-pi/extensions/btw
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
- The snapshot preserves message roles, removes images and excluded messages, and is bounded before the call.
- The overlay shows the actual `provider/model` used.
- Each attempt emits a payload-free `terrific-pi:auxiliary-usage-v1` event through the auxiliary bridge.
- Authentication is resolved from Pi's model registry into an in-memory credential store; `auth.json` is not read by the sidecar.
- Print/JSON modes return an explicit unsupported-mode error without calling a model.

## Appearance

Package-owned config menus and answer overlays opt into the Terrific native profile only when `$PI_CODING_AGENT_DIR/terrific.json` contains the exact global value:

```json
{
  "appearance": { "profile": "terrific-native-v1" }
}
```

The profile is reread whenever a BTW command starts. An in-flight request keeps its initial visual snapshot through the answer overlay. Missing, malformed, non-object, `off`, unknown, and project-local appearance values fail closed without a BTW notification. Active config menus use one compact responsive boundary, accented selection, muted em-dash descriptions, rebound-key hints, circular navigation, and filtering only for lists longer than 10 items. The active answer overlay changes only chrome, spacing, glyphs, and live terminal-row geometry; scrolling, copy, editor, retry, and cancel actions are unchanged. `TERM=dumb` uses ASCII chrome.

Rollback by setting `appearance.profile` to `off` or removing it; the next BTW command uses the original menu and overlay renderers.

## Verify

```bash
npm run check
npm run benchmark
```

The opt-in benchmark measures exactly 30 timed samples of 100 active pure renders per surface at 160 columns, reports nearest-rank per-render p95, and requires menu and overlay p95 below 16 ms.
