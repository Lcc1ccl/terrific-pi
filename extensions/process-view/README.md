# process-view

Structured task progress and live tool activity HUD for [pi](https://pi.dev).

Process View keeps the default conversation quiet while making non-trivial work inspectable at three levels:

- a compact editor-above HUD for the goal, task progress, current-step time, blocker, and safe tool activity
- a live task/runtime panel when Pi's native tool expansion is enabled (default `Ctrl+O`)
- compact `process_update` receipts with expandable historical details

## Install

```bash
pi install /path/to/terrific-pi/extensions/process-view
```

For this repository's development layout, add the package next to the other terrific-pi packages in `~/.pi/agent/settings.json`:

```json
"../vendor/terrific-pi/extensions/process-view"
```

Reload Pi after changing packages:

```text
/reload
```

## Behavior

The extension registers one model-facing tool, `process_update`. The model uses it only for work with at least three meaningful user-visible steps and publishes a complete snapshot at milestones. Simple answers use only the passive stage/activity HUD and leave no task state behind.

Snapshots support:

- `running`, `waiting`, `blocked`, and `completed`
- one to five outcome-oriented steps
- a concise update, blocker, verification, and up to five artifacts
- branch-aware restoration through `process-view-state-v1` custom entries
- extension-owned step timing plus model, token, cache, and cost telemetry without adding model-facing fields

Tool calls execute sequentially. Invalid snapshots throw without changing memory, session state, or the Widget. The call itself is hidden; the result uses a self-rendered, borderless receipt. Use Pi's current `app.tools.expand` binding to inspect historical task and runtime details.

## HUD

The Widget key is `terrific-pi:process-view` and uses Pi theme tokens. Its compact first line keeps the goal, completed/total task count, current step, and current-step active time together. Activity and the latest update use at most two additional lines.

When Pi's native tool expansion is enabled, compact mode switches to a live panel with:

- goal status, task count, percentage, current step, and active time
- every step's completion state, active time, LLM turns, token use, and model when available
- task-local input/output/cache/cost totals and current safe tool activity
- the latest blocker, update, verification, or artifact labels

The panel is responsive, bounded to 15 lines, and `/process full` pins it open. Step time pauses while Waiting, Blocked, or Interrupted and resumes if the same step becomes active again.

Only `read`, `edit`, `write`, `grep`, `find`, and `ls` may show a sanitized path. Paths outside the workspace show only their basename. `bash` never shows its command, and unknown tools never serialize arguments or results.

## Commands

```text
/process              show mode and current task summary
/process compact      compact by default; follow Pi's native tool expansion
/process full         pin the live task/runtime panel open
/process off          hide the HUD while retaining state and receipts
/process clear        write a tombstone and clear the current task
```

View mode is stored per session branch. No global Process View config file is created, and the extension registers no shortcuts. The default `Ctrl+O` remains owned by Pi as `app.tools.expand`, so user keybinding overrides continue to work.

## Lifecycle

- A new user request writes a tombstone before starting, so old Waiting or Blocked state cannot reappear if the new request never calls `process_update`.
- Unfinished state from the previous request or a compaction is injected into the next provider context once, as a bounded hidden `process-view-context` message.
- The reminder contains only title, status, steps, and blocker. It is not written to the session and may not appear as a separate item in `/context` accounting.
- A running snapshot becomes Waiting after `agent_settled`, shutdown/reload, or recovery of a stale running entry; the extension never claims completion automatically.
- Active-step timing pauses in Waiting, Blocked, or Interrupted state, so offline time is not counted; a one-second UI tick runs only while a timed Widget is visible.
- Finalized assistant messages add their real provider/model usage to extension-owned task telemetry; telemetry never relies on model-authored values.
- `aborted` or `error` becomes Interrupted only if still final at `agent_settled`. Automatic retry clears the pending interruption.
- Completed HUD state hides at settled; its conversation receipt remains.

Tree navigation and resume reconstruct only the selected branch. Active tool telemetry is always reset because prior-process tools cannot still be running.

## Reasoning

Process View customizes the hidden-thinking label with Pi's current `app.thinking.toggle` binding. It does not delete, rewrite, or intercept reasoning.

To make the quiet view the default, set this explicitly in `~/.pi/agent/settings.json`:

```json
{
  "hideThinkingBlock": true
}
```

Remove the field or set it to `false` to roll back. The extension never edits settings itself.

## Integration

- `statusline`: `process_update` is metadata and is excluded from footer `toolActivity`; business tools remain counted.
- `mode`: ask/plan may remove the custom tool. Passive HUD telemetry still works, and Process View does not widen permissions.
- `fast`: no provider request or header changes.
- `context`: only the bounded one-shot lifecycle reminder described above.
- `btw`: isolated sessions do not write Process View state into the main session.

## Privacy And Failure Handling

- No network requests, command execution, workspace writes, or artifact storage; the only timer is the one-second visible-HUD repaint tick described above.
- No reasoning text, bash command, unknown arguments, tool result bodies, credential, or URL query is copied into the HUD.
- Model/token/cache/cost fields come only from Pi's finalized assistant metadata; model-authored text cannot supply them.
- All model-controlled text is stripped of terminal/control sequences and bounded before display.
- Custom entries are not sent to the model; only the one-shot reduced reminder enters provider context.
- Widget failures are notified once and do not roll back a successfully persisted tool result.
- Corrupt persisted state fails closed and is reported once.

## Develop

```bash
cd extensions/process-view
npm install
npm run check
```

The package has no runtime dependency beyond Pi's peer APIs and TypeBox supplied by Pi.
