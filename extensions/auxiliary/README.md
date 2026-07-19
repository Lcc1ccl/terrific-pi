# auxiliary

Task-scoped auxiliary model runtime for Pi. It runs bounded side calls without changing the main session model, thinking level, or conversation history.

## Capabilities

- Native Pi compaction through `session_before_compact`
- First-settled-turn session title generation
- `aux_summarize` for explicit text or the latest text tool result
- `web_research` through the public `pi-subagents` delegation v1 contract
- `git_finalize` for already staged changes, with exact confirmation and optional normal push
- Canonical branch-local usage entries and active-task status
- Vision usage bridge for `pi-vision-handoff`

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
npm:pi-subagents@0.35.1
npm:pi-web-access@0.13.0
npm:pi-vision-handoff@0.8.1
```

`web_research` fails closed when the `pi-subagents` delegation bridge is unavailable. The auxiliary core does not silently launch another agent implementation.

## Configure

Only the global file is read for auxiliary routing:

```text
~/.pi/agent/pi-essentials.json
```

Project-local `auxiliary` config is intentionally ignored because a model route decides which provider receives project data. The config must not contain API keys, headers, or base URLs; authentication and endpoints stay in Pi's model registry.

See [`../../agent/pi-essentials.example.json`](../../agent/pi-essentials.example.json) for the complete template. Each task can set:

- `model`: explicit `provider/model`, or `current` only when intentionally configured
- `thinking`
- `timeoutMs`
- `maxOutputTokens`
- `maxRetries`
- up to three `fallbackModels`

Built-in task keys are `compression`, `title_generation`, `text_summary`, `commit_message`, `btw`, `web_research`, and `vision`.

## Commands And Tools

```text
/aux status
/aux tasks
/aux summarize <text>
```

`aux_summarize` accepts either explicit text or `source=last_tool_result`. Long input uses at most eight chunks with at most two concurrent calls; any chunk failure cancels the whole summary.

`web_research` always requests the fixed `researcher` agent with fresh context, no inherited skills, and blocked mutation/subagent tools. Its result must fit 2,500 characters and include at least three source URLs.

`git_finalize`:

1. Requires already staged changes.
2. Sends only branch/upstream, name-status, stat, recent subjects, file count, and optional intent to the model.
3. Validates one Conventional Commit subject, with at most one repair call.
4. Confirms the exact branch, message, and push action.
5. Rechecks a SHA-256 fingerprint over full staged blob IDs before commit.
6. Uses normal `git push --porcelain` only when an upstream already exists.

It never stages files, creates an upstream, force pushes, pushes tags, or rebases. A successful local commit is retained and reported if push fails.

## Usage And Visibility

Each attempt appends `terrific-pi:auxiliary-usage-v1` to the current session branch. Entries contain model/task/status/usage metadata only, never prompts, responses, diffs, URLs, tool arguments, or error stacks.

While a call is active, status key `auxiliary` renders as:

```text
aux compression · gpt-5.4-mini
aux 2 tasks
```

The statusline's optional `auxUsage` widget reads only the active branch and keeps auxiliary cost separate from main session cost.

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
