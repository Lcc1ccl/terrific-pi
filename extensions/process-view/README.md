# process-view

Structured task progress and live tool activity HUD for [pi](https://pi.dev).

Process View keeps the default conversation quiet while making non-trivial work inspectable at three levels:

- an editor-above HUD for the current step, blocker, and safe tool activity
- compact `process_update` receipts in conversation history
- Pi's native thinking and tool expansion views for full audit

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

Tool calls execute sequentially. Invalid snapshots throw without changing memory, session state, or the Widget. The call itself is hidden; the result uses a self-rendered, borderless receipt. Use Pi's current `app.tools.expand` binding to inspect its full normalized details.

## HUD

The Widget key is `terrific-pi:process-view` and uses Pi theme tokens. It renders:

- wide terminals: status, horizontal step rail, activity/outcome, and update
- medium terminals: status, Current/Next, activity/outcome, and update
- narrow terminals: one bounded line, prioritizing Blocked/Interrupted reasons
- full mode: at most nine lines

Only `read`, `edit`, `write`, `grep`, `find`, and `ls` may show a sanitized path. Paths outside the workspace show only their basename. `bash` never shows its command, and unknown tools never serialize arguments or results.

## Commands

```text
/process              show mode and current task summary
/process compact      use the responsive HUD (default)
/process full         show all steps and available result fields
/process off          hide the HUD while retaining state and receipts
/process clear        write a tombstone and clear the current task
```

View mode is stored per session branch. No global Process View config file is created, and the extension registers no shortcuts.

## Lifecycle

- A new user request writes a tombstone before starting, so old Waiting or Blocked state cannot reappear if the new request never calls `process_update`.
- Unfinished state from the previous request or a compaction is injected into the next provider context once, as a bounded hidden `process-view-context` message.
- The reminder contains only title, status, steps, and blocker. It is not written to the session and may not appear as a separate item in `/context` accounting.
- A running snapshot becomes Waiting only after `agent_settled`; the extension never claims completion automatically.
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

- No network requests, timers, command execution, workspace writes, or artifact storage.
- No reasoning text, bash command, unknown arguments, tool result bodies, token, or URL query is copied into the HUD.
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
