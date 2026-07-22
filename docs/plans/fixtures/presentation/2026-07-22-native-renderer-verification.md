# Native Renderer TUI Verification

- Runtime: Pi `0.81.1`, isolated `PI_CODING_AGENT_DIR`, `presentation` as the only package.
- Fixture: UI-only model, exploration, and 16-file artifact entries; no model request or user session was used.
- Captured with tmux at 80, 120, and 160 columns. Each collapsed fixture entry occupied exactly one terminal row; the largest captured row equaled, but did not exceed, its terminal width.
- A 120-column `Ctrl+O` capture confirms the same entries expose timestamp, exploration detail, and bounded artifact rows.
- Separate status check reported `integration: tools=native wrappers active`.

This validates renderer loading and width behavior. Authenticated model-driven execution, error output, Skill loading, reload, and resume are separately verified in [2026-07-22-live-model-verification.md](./2026-07-22-live-model-verification.md).
