# terrific-pi AGENTS.md

默认语言：简体中文；代码、路径、命令和标识符使用 English。

## Repository boundary

This repository is the core `terrific-pi` Pi/npm package. It owns exactly three domains:

| Directory | Domain |
|---|---|
| `packages/interface/` | statusline, appearance, taskboard, presentation |
| `packages/session-control/` | mode, fast, context, model-profile |
| `packages/runtime/` | auxiliary, btw |
| `skills/` | package-discovered global Agent Skills source |
| `config/examples/` | public, non-secret configuration examples |
| `docs/` | capability map, historical lessons, and plans |

Pilot and Docsflow belong to the separate `terrific-pi-automation` repository. Core runtime code must not import Automation source.

## Package rules

- The root `package.json` is the only release manifest and version.
- Nested component manifests stay `private: true` and retain package-local tests.
- Root `pi.extensions` and `pi.skills` paths are explicit and covered by `tests/manifest.test.ts`.
- The root package has no ordinary runtime dependencies; Pi-provided APIs remain peer dependencies.
- Third-party Pi packages are installed separately and declared as required or optional Pi package specs, never hidden npm dependencies.
- Do not introduce npm workspaces or a shared monorepo runtime without a demonstrated need.

## Domain ownership

- Statusline is the sole footer owner.
- Appearance owns only header and editor surfaces.
- Taskboard owns structured task state and HUD.
- Presentation owns transcript compatibility and file receipts.
- Mode owns active tool policy; Fast owns request-tier injection.
- Auxiliary owns bounded side calls and usage entries; BTW owns isolated Q&A.
- Cross-package integration uses Pi public APIs, status keys, versioned events, or session entries. Avoid runtime relative imports between components.

## Configuration

- Shared core configuration uses `terrific.json`; statusline layout uses `statusline.json`.
- Writers modify only their own section, preserve unknown sibling fields, use the shared lock convention, and refuse malformed JSON.
- Project overrides require trusted project context. Auxiliary model routing remains global-only.
- Repository examples are not automatically installed or merged into live config.

## Development

Before adding or materially changing a package:

1. Scan existing repository packages and current capability docs.
2. Read installed official Pi package/extension docs and relevant examples.
3. Check reviewed community packages before creating a new extension.
4. Prefer Pi public APIs and the smallest compatible implementation.
5. Record cross-package UI/status/config conclusions.

Use test-driven changes for behavior. Run the changed component check first, then root `npm run check`.

## Release verification

Before a Git/npm release:

1. Run `npm run check`.
2. Run `npm pack --dry-run --json`, then inspect a real packed tarball.
3. Verify root manifest resources, package ownership, and optional dependency behavior.
4. Scan Git tracked files and npm payload for secrets, sessions, JSONL, `.pi-subagents`, private keys, and machine-local paths.
5. Test core alone and together with the packed Automation package in an isolated Pi home.
6. Record tag, commit SHA, npm integrity, and rollback version.

## Safety

- Never commit or publish auth files, credentials, sessions, trust state, worktrees, `.pi-subagents`, or machine-local configuration.
- Never overwrite live `~/.pi` configuration as part of package development or publishing.
- Do not run destructive Git operations, create tags, push, or publish without explicit user authorization.
- Commit, push, Git release, npm publish, and dist-tag promotion are independent checkpoints.
