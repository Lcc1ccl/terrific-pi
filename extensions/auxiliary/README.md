# auxiliary

Task-scoped auxiliary model runtime for Pi. It runs bounded side calls without changing the main session model, thinking level, or conversation history.

## Capabilities

- Native Pi compaction through `session_before_compact`
- First-settled-turn session title generation (detached so it does not delay idle)
- `aux_summarize` for explicit text or the latest text tool result
- `web_research` through the public `pi-subagents` delegation v1 contract
- `git_finalize` for already staged changes, with exact confirmation and optional normal push
- Canonical branch-local usage entries and active-task status
- Vision usage bridge for `pi-vision-handoff`
- Versioned internal `pilot_router` request/response bridge retained for compatibility; the current manual Pilot Copilot does not call it

The core package has no runtime dependencies beyond Pi peer APIs and Node.js.

## Hermes Mapping

This package follows Hermes-style **explicit task keys**, not a per-prompt model classifier and not temporary main-model switching.

| Hermes slot / behavior | Execution shape | terrific-pi 0.1.0 |
|---|---|---|
| `compression` | text one-shot | Implemented via Pi `session_before_compact` + native `compact()` |
| `title_generation` | short text one-shot | Implemented on first settled turn |
| generic one-shot summary / commit text | text one-shot | `aux_summarize`, `/aux summarize`, `git_finalize` subject generation |
| side-channel Q&A | isolated no-tools session | `/btw` reads `auxiliary.tasks.btw` |
| tool-using research | isolated tool agent | `web_research` → pinned `pi-subagents` researcher (fresh context) |
| `vision` | multimodal pipeline | Reuse pinned `pi-vision-handoff`; core only bridges usage |
| `web_extract` | domain package / source-aware extract | Reuse pinned `pi-web-access`; not reimplemented here |
| `approval` | constrained reviewer | Deferred; optional `pi-approval-guardian` later |
| `background_review` / memory | isolated agent or memory package | Deferred; optional `pi-hermes-memory` later |
| `skills_hub`, TTS, Kanban, Goal, MCP, MoA, Curator | various | Out of 0.1.0 scope; no empty stubs |

Deliberate differences from Hermes:

- no silent fallback to the expensive main model except Pi default compaction recovery
- no provider auto-discovery or credential-pool clone
- no universal "any prompt + any tools" auxiliary API
- Git finalize is deterministic staged-only automation, not a free-form agent loop

## Install

Add the local package to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "../vendor/terrific-pi/extensions/auxiliary"
  ]
}
```

For bounded web research and vision handoff, install the reviewed fixed versions separately:

```text
git:github.com/nicobailon/pi-subagents@bd32df2cc1a951b588f6f93f67f3b9adac406303
npm:pi-web-access@0.13.0
npm:pi-vision-handoff@0.8.1
```

`web_research` fails closed when the `pi-subagents` delegation bridge is unavailable. The auxiliary core does not silently launch another agent implementation.

## Configure

Only the global file is read for auxiliary routing:

```text
~/.pi/agent/terrific.json
```

Project-local `auxiliary` config is intentionally ignored because a model route decides which provider receives project data. The config must not contain API keys, headers, or base URLs; authentication and endpoints stay in Pi's model registry.

Run `/aux config` in TUI mode to edit the global runtime, default route, and task routes. The selected menu item shows a wrapped `Tip:` explaining its runtime impact. Model pickers use fuzzy matching across model IDs, full refs, and display names, so queries such as `5.6` or `sol` find `gpt-5.6-sol`. Each confirmed change is written atomically while preserving other `terrific.json` sections; malformed JSON is never overwritten.

The Default route menu includes **Apply primary model to all tasks**. After confirmation, it copies the effective default model to the six public task routes and enables auxiliary routing for each. Existing thinking, timeout, output, retry, fallback, and unknown task fields remain unchanged; internal compatibility and vision routes are excluded.

See [`../../agent/terrific.example.json`](../../agent/terrific.example.json) for the complete template. Each task can set:

- `useAuxiliary`: set `false` to run the task with the current main model while preserving its saved auxiliary route
- `model`: explicit `provider/model`, or `current` only when intentionally configured
- `thinking`, `timeoutMs`, and fields consumed by that task
- up to three ordered `fallbackModels`

Most routes expose `maxOutputTokens` and `maxRetries`. Compression and BTW do not consume retries, while Web Research owns its bounded result contract and consumes neither retries nor a route-level output cap, so those ineffective fields are hidden from their menus. The public `/aux config` task list is `compression`, `title_generation`, `text_summary`, `commit_message`, `btw`, and `web_research`. The retained `pilot_router` bridge is a dormant config-file compatibility key; it defaults to 10 seconds, 128 output tokens, and no retries, while existing `tasks.pilot_router` overrides remain honored. The current manual Pilot package never requests it, so it is omitted from menus and status. Vision routing remains owned by `/vision-handoff`; `/aux config` shows that external entry only when the command is loaded and never writes an ineffective `tasks.vision` block.

## Commands And Tools

```text
/aux                         open the TUI manager (or print status outside TUI)
/aux config                  edit routes and Git finalize policy
/aux status                  effective routes, branch usage, and recent errors
/aux summarize <text>
```

`aux_summarize` accepts either explicit text or `source=last_tool_result`. Long input uses at most eight chunks with at most two concurrent calls; any chunk failure cancels the whole summary.

`web_research` always requests the fixed `researcher` agent with fresh context, no inherited skills, and blocked mutation/subagent tools. Its result must fit 6,000 characters and include 3-8 distinct source URLs. Contract-invalid primary output is recorded and advances to the configured fallback.

`git_finalize`:

1. Requires already staged changes.
2. Sends only branch/upstream, name-status, stat, recent subjects, file count, and optional intent to the model.
3. Validates one Conventional Commit subject, with at most one repair call.
4. Confirms the exact branch, message, and push action.
5. Rechecks a SHA-256 fingerprint over full staged blob IDs before commit.
6. Uses normal `git push --porcelain` only when an upstream already exists.
7. Must be the only tool call in its assistant response. A successful local commit locks further tool calls for that turn but permits the final assistant result.
8. Returns a versioned `git_finalize@1` receipt so Taskboard can complete only an eligible terminal commit step.

It never stages files, creates an upstream, force pushes, pushes tags, or rebases. A successful local commit is retained and reported if push fails; a requested push failure remains a partial operation, not task completion.

## Usage And Visibility

Each attempt appends `terrific-pi:auxiliary-usage-v1` to the current session branch. Entries contain model/task/status/usage metadata only, never prompts, responses, diffs, URLs, tool arguments, or error stacks.

While a call is active, status key `auxiliary` still tracks the task, but statusline progress ignores it so Taskboard can own live tool/model display (`web_research · provider/model` via tool updates).

Branch-local usage is folded into the statusline main `tokens` / `cost` widgets as dim `Ⅰ` suffixes (no separate aux widget or call counter).

## Mode Semantics

- ask/plan: `aux_summarize` and fixed read-only `web_research`
- edit/auto: the normal baseline, including `git_finalize`
- internal title and compaction hooks: all modes

Auxiliary side calls do not inherit `/fast`, do not call `process_update`, and do not alter `/context` occupancy.

## Verify

```bash
npm run check
npm pack --dry-run
```
