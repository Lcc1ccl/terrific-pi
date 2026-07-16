# codex-statusline

Codex-style statusline footer for [pi](https://pi.dev) coding agent.

Mirrors openai/codex `status_line_style.rs` adaptive Catppuccin defaults, with segment colors softened to 85% saturation.

## Features

- Path (home-relative `~`)
- Model + thinking level
- Token usage (input / output, compact K/M/B/T)
- Context remaining percent
- Git branch + branch diff vs default branch (`+N -M`)
- Extension task progress statuses
- Run state: Ready / Thinking / Working

## Install

```bash
pi install /tmp/codex-statusline
# or from a packed tarball:
pi install /tmp/codex-statusline-1.0.0.tgz
```

## Structure

```
codex-statusline/
├── package.json
├── README.md
└── extensions/
    └── codex-statusline.ts
```
