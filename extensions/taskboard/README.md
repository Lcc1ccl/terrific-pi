# taskboard

Structured task milestones and task-scoped HUD for [pi](https://pi.dev).

Taskboard keeps multi-step work inspectable while `presentation` owns collapsed tool history:

- a compact editor-above HUD for the goal, task progress, current-step time, and blocker
- a live task panel when Pi's native tool expansion is enabled (default `Ctrl+O`)
- expandable `process_update` history without repeating the snapshot currently visible in the HUD

## Install

```bash
pi install /path/to/terrific-pi/extensions/taskboard
```

For this repository's development layout, add the package next to the other terrific-pi packages in `~/.pi/agent/settings.json`:

```json
"../vendor/terrific-pi/extensions/taskboard"
```

Reload Pi after changing packages:

```text
/reload
```

## Behavior

The extension registers one model-facing tool, `process_update`. The model uses it only for work with at least three meaningful user-visible steps and publishes a complete snapshot at milestones. Simple answers leave no task state behind; passive runtime activity appears only with `activityMode: "full"`.

Snapshots support:

- `running`, `waiting`, `blocked`, and `completed`
- deterministic completion from a verified terminal `git_finalize` receipt: only when every prior step is done and the sole active final step is ready to commit
- one to five outcome-oriented steps
- a concise update, blocker, verification, and up to five artifacts
- branch-aware restoration through `process-view-state-v1` custom entries
- extension-owned step timing plus model, token, cache, and cost telemetry without adding model-facing fields

Tool calls execute sequentially. Invalid snapshots throw without changing memory, session state, or the Widget. The call itself is hidden. While the HUD owns the current snapshot, its successful collapsed result is suppressed; it reappears after a newer milestone replaces it, or after the completed HUD settles away. Expanded details and errors are never suppressed. Use Pi's current `app.tools.expand` binding to inspect task and runtime history.

## HUD

The Widget key is `terrific-pi:taskboard` and uses Pi theme tokens. Its compact first line keeps the goal, completed/total task count, current step, and current-step active time together. The latest blocker, update, or verification may use one additional line.

`taskboard.activityMode` controls runtime activity independently from task state. Existing `processView` config is read only when `taskboard` is absent; the next `/taskboard default <mode>` migrates it atomically:

- `full` (default): show aggregate runtime activity in compact task views and detailed sanitized activity in expanded task views. Compact mode intentionally shows counts/outcomes rather than duplicating native tool-row labels.
- `task`: hide passive and collapsed runtime activity; expanded task panels still show it for inspection. Use it only when another stable activity surface is enabled.
- `off`: hide runtime activity entirely while retaining task state.

Taskboard writes only the `taskboard` object and preserves unknown legacy fields during that migration.

When Pi's native tool expansion is enabled, compact mode switches to a live panel with:

- goal status, completed/total task count, current step, total task time, and current-step time
- every step's completion state, active time, turns, ↑input ↓output, and model when available
- task-local input/output/cache/cost totals and runtime activity when `activityMode` is not `off`
- the latest blocker, update, verification, or artifact labels

LLM turn wall-clock (current turn / session) stays in statusline `duration`; Taskboard only shows task/step active time and usage totals.

The panel is responsive, bounded to 15 lines, and `/taskboard full` pins it open. Step time pauses while Waiting, Blocked, or Interrupted and resumes if the same step becomes active again.

When activity is visible, only `read`, `edit`, `write`, `grep`, `find`, and `ls` may show a sanitized path. Paths outside the workspace show only their basename. `bash` never shows its command, and unknown tools never serialize arguments or results.

## Commands

```text
/taskboard              TUI manager: summary, view mode, global default, live-panel expansion, confirmed clear
/taskboard compact      compact by default; follow Pi's native tool expansion
/taskboard full         pin the live task/runtime panel open
/taskboard off          hide the HUD while retaining state and receipts
/taskboard clear        TUI confirmation, then write a tombstone and clear the current task
/taskboard default <mode>  save compact|full|off for new session branches
```

Outside TUI mode, bare `/taskboard` prints the current summary and `/taskboard clear` refuses without TUI confirmation. View mode is stored per session branch. `taskboard.defaultViewMode` in `~/.pi/agent/terrific.json` supplies the initial mode only when a branch has no saved Taskboard state; `/taskboard default <mode>` writes that global default. The extension registers no shortcuts. The default `Ctrl+O` remains owned by Pi as `app.tools.expand`, so user keybinding overrides continue to work.

## Compatibility Window

| Contract | Policy |
|----------|--------|
| `process_update`, `process-view-state-v1`, `process-view-context` | Durable tool/session contracts; no planned removal |
| `/process`, `processView`, legacy `process` status, presentation's `/process` detection | Transitional aliases through Taskboard `0.1.x`; removed when `0.2.0` becomes the baseline |

Use `/taskboard` and the `taskboard` config/status keys for all new integrations. Running `/taskboard default <mode>` or `/process default <mode>` migrates the legacy config object atomically.

## Lifecycle

- A new user request writes a tombstone before starting, so old Waiting or Blocked state cannot reappear if the new request never calls `process_update`.
- Unfinished state from the previous request or a compaction is injected into the next provider context once, as a bounded hidden `process-view-context` message.
- The reminder contains only title, status, steps, and blocker. It is not written to the session and may not appear as a separate item in `/context` accounting.
- A running snapshot becomes Waiting after `agent_settled`, shutdown/reload, or recovery of a stale running entry. The only automatic completion path is a validated `git_finalize` receipt for an eligible final process step; a partial requested push marks that step failed and keeps the task Waiting.
- Active-step timing pauses in Waiting, Blocked, or Interrupted state, so offline time is not counted; a one-second UI tick runs only while a timed Widget is visible.
- Finalized assistant messages add their real provider/model usage to extension-owned task telemetry; telemetry never relies on model-authored values.
- `aborted` or `error` becomes Interrupted only if still final at `agent_settled`. Automatic retry clears the pending interruption.
- Completed HUD state hides at settled; its conversation receipt remains.

Tree navigation and resume reconstruct only the selected branch. Active tool telemetry is always reset because prior-process tools cannot still be running.

## Integration

- `statusline`: recommended configuration omits `toolActivity`; Waiting/blocked Taskboard state is published on the `taskboard` status key so footer `state` shows Waiting. Statusline also accepts legacy `process` while old sessions or extensions finish migration.
- `presentation`: its display-only native renderer owns collapsed tool rows and its file ledger projects ordinary successful file-change receipts onto one native tool row; `process_update.artifacts` remains for tests, screenshots, URLs, commits, and reports.
- `mode`: ask/plan may remove the custom tool. Taskboard does not widen permissions.
- `fast`: no provider request or header changes.
- `context`: only the bounded one-shot lifecycle reminder described above.
- `btw`: isolated sessions do not write Taskboard state into the main session.

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
cd extensions/taskboard
npm install
npm run check
```

The package has no runtime dependency beyond Pi's peer APIs and TypeBox supplied by Pi.
