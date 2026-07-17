# btw

Pi `/btw` one-shot side-channel Q&A over an isolated in-memory session.
Does not write the main session or expose tools/resources.

## Install

```bash
"../vendor/terrific-pi/extensions/btw"
```

## Configure

```json
{
  "btw": {
    "thinking": "minimal",
    "maxContextTokens": 80000,
    "maxOutputTokens": 2000
  }
}
```

File: `~/.pi/agent/pi-essentials.json` (or trusted project `.pi/pi-essentials.json`).

## Command

- `/btw [question]` — side Q&A; cancel ends the isolated request only
- The snapshot preserves message roles, omits images, and is strictly bounded by the configured estimate
- Print/JSON modes return an explicit unsupported-mode error without calling a model

## Verify

```bash
npm run check
```
