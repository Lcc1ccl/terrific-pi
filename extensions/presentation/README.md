# presentation

Low-noise Pi transcript presentation with one display owner per fact.

`presentation` does not register, replace, or execute built-in tools. It keeps Pi's native tool definitions, schemas, permissions, inputs, and results intact, then applies a guarded display-only compatibility layer to the native user-message and tool-execution components.

## Install

Load `presentation` after `taskboard`:

```json
"../vendor/terrific-pi/extensions/presentation"
```

No external transcript or tool-display fork is required.

## Behavior

- User messages use a full-width `user` frame by default. The renderer calls Pi's original Markdown renderer first, preserves its ANSI and OSC 133/633 markers, then adds the frame. Narrow widths or compatibility failures fall back to Pi's original output.
- Collapsed built-in rows have one display owner. Bash has running, success, and error states; command text stays out of collapsed history. `Ctrl+O` (or the configured `app.tools.expand` binding) always restores Pi's native call and result detail.
- Exact `read` matches for `systemPromptOptions.skills[].filePath` show `Skill(name) - loading/loaded`; ordinary files named `SKILL.md` are not inferred as skills.
- Read/search/list batches become a single exploration summary. Bash, mutations, and custom tools retain their own native lifecycle rows.
- Successful file changes are one request-scoped net receipt projected onto the final contributing native tool row. It merges repeated write/edit calls, ignores index-only commit cleanup, and still tracks a Bash change committed within the same request.
- `compactTools: false` restores native collapsed tool rows without losing file receipts.
- Legacy `presentation-tools-v1` and `presentation-artifacts-v1` entries remain in session JSONL but are intentionally hidden so restored sessions do not duplicate native history.
- Workspace, model, thinking, mode, fast, and explicit skill invocation entries remain UI-only. Final assistant Markdown stays native.

The compatibility layer patches only `UserMessageComponent.prototype.render` and `ToolExecutionComponent.prototype.render`. It is reference-counted, compare-and-swap on unload, and never patches tool execution methods or Pi core files.

## Configuration

Configuration shares `$PI_CODING_AGENT_DIR/terrific.json` (normally `~/.pi/agent/terrific.json`):

```json
{
  "presentation": {
    "enabled": true,
    "workspace": true,
    "systemEvents": true,
    "artifacts": true,
    "userMessageBox": true,
    "compactTools": true,
    "maxExpandedArtifacts": 8
  }
}
```

`userMessageBox` and `compactTools` both default to `true`. Runtime toggles are dynamic: disabled features pass through to Pi's original renderer; file receipts remain available when compact tools are disabled.

Malformed JSON fails closed for this extension and is reported once. `/presentation` changes only the `presentation` section atomically.

## Commands

```text
/presentation                 # TUI configuration menu
/presentation config          # explicit menu entry
/presentation status          # effective config and integration state
/presentation on|off          # master display switch
/presentation workspace on|off # workspace entry
/presentation system on|off    # system event entries
/presentation user on|off      # user-message frame
/presentation tools on|off    # compact tool rows
/presentation artifacts on|off
/presentation reset           # restore presentation defaults
```

## Develop

```bash
cd extensions/presentation
npm run check
```
