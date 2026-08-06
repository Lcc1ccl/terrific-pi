# terrific-pi

`terrific-pi` is the core Pi enhancement package for interface presentation, session control, and bounded auxiliary runtime capabilities. Automation is distributed separately by `terrific-pi-automation`.

## Install

Git release:

```bash
pi install git:github.com/Lcc1ccl/terrific-pi@<tag>
```

Npm release:

```bash
pi install npm:terrific-pi@<version>
```

Local development checkout:

```bash
pi install ~/.pi/vendor/terrific-pi
```

Pi writes the package entry to `settings.json`. This package never snapshots, restores, or overwrites device configuration.

## Domains

| Domain | Packages | Responsibility |
|---|---|---|
| Interface | `statusline`, `appearance`, `taskboard`, `presentation` | Footer, header/editor, task HUD, and transcript presentation |
| Session control | `mode`, `fast`, `context`, `model-profile` | Tool permissions, request tier, context inspection, and model/thinking profiles |
| Runtime | `auxiliary`, `btw` | Bounded side-model tasks, Git finalize, web research delegation, and isolated Q&A |

The repository root is the only release package and version. Nested component packages remain private development and test boundaries.

## Optional Packages

Auxiliary Web Research requires separately installed Pi packages:

```bash
pi install git:github.com/nicobailon/pi-subagents@bd32df2cc1a951b588f6f93f67f3b9adac406303
pi install npm:pi-web-access@0.13.0
```

Missing optional packages produce an explicit unavailable result; core startup and other Auxiliary routes remain usable.

Automation is a separate opt-in security and release boundary:

```bash
pi install git:github.com/Lcc1ccl/terrific-pi-automation@<tag>
```

It provides Pilot and Docsflow and is not loaded by this package.

## Configuration

Device-local files remain authoritative:

| File | Owner |
|---|---|
| `~/.pi/agent/terrific.json` | Core package sections such as `mode`, `fast`, `context`, `auxiliary`, `btw`, `taskboard`, `presentation`, `appearance`, and `modelProfile` |
| `~/.pi/agent/statusline.json` | Statusline layout and widgets |
| `~/.pi/agent/settings.json` | Pi package list and model defaults |
| `~/.pi/agent/models.json` | Pi model registry |
| `~/.pi/agent/auth.json` | Credentials; never part of this repository or npm package |

Examples live under `config/examples/`. Package writers modify only their own section, preserve unknown sibling keys, and refuse malformed JSON.

## Development

```bash
npm install
npm run check
npm pack --dry-run --json
```

Published packages omit development tests. Run the checks from a source checkout before publishing.

## Release Boundary

- Git and npm use the same root manifest and SemVer.
- Git tags, commits, npm integrity, and release notes must refer to the same source state.
- Snapshot, custom tar archive, restore installer, and automatic settings merge flows have been retired.
- Commit, push, tagging, npm publish, and dist-tag promotion are separate explicit checkpoints.
