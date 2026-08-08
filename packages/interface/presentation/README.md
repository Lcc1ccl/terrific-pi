# presentation

Low-noise Pi transcript presentation with one display owner per fact.

`presentation` does not register, replace, or execute built-in tools. It keeps Pi's native tool definitions, schemas, permissions, inputs, results, message history, and Markdown renderer intact, then applies a guarded display-only compatibility layer to native assistant-, user-, and tool-message components.

## Install

Install the `terrific-pi` root package; its manifest loads Taskboard before Presentation:

```bash
pi install /path/to/terrific-pi
```

No external transcript or tool-display fork is required.

## Behavior

The default `omp` style changes transcript projection only:

- User messages keep Pi's native full-width shaded band and OSC 133/633 prompt zones.
- Hidden thinking uses the OMP starburst pulse only while the assistant stream currently ends in thinking. Real streamed usage may add token count and rolling speed; final history removes the pulse, speed, hidden-thinking placeholder, and Pi's leading assistant spacer. Final assistant Markdown remains Pi-native.
- Consecutive reads render as a path tree. Search, list, Bash, edit/write, and generic tools use bounded state blocks with privacy filtering before truncation. `process_update` remains native.
- `Ctrl+O` (or the configured `app.tools.expand` binding) always restores Pi's native tool call/result view. OMP artifact anchors keep the collapsed tool block plus one request-level net file receipt; expanded output is native-only.

The `classic` style preserves the earlier presentation behavior: framed user messages, single-line compact Bash/tool states, and combined read/search/list exploration summaries. Switching styles is dynamic and does not rewrite session history.

Successful file changes remain one request-scoped net receipt projected onto the final contributing native tool row. Exact registered Skill reads keep their `Skill(name)` identity. Legacy projection entries remain hidden so restored sessions do not duplicate native history.

Compatibility patches are all-or-nothing for `AssistantMessageComponent.prototype.render`, `UserMessageComponent.prototype.render`, and `ToolExecutionComponent.prototype.render`. Any Pi version with the required component constructors and methods is accepted; missing exports or methods fall back to native output with one warning. Patch ownership remains reference-counted and compare-and-swap on unload.

Presentation does not own Pi root TUI, terminal/session/provider streaming, themes, statusline, header, editor, footer, widgets, working indicator, tool execution, permissions, sandboxing, or model context. OMP-derived pulse glyphs are attributed under MIT in `lib/LICENSES/oh-my-pi-MIT.txt`.

## Configuration

Configuration shares `$PI_CODING_AGENT_DIR/terrific.json` (normally `~/.pi/agent/terrific.json`):

```json
{
  "presentation": {
    "enabled": true,
    "style": "omp",
    "workspace": true,
    "systemEvents": true,
    "artifacts": true,
    "userMessageBox": true,
    "compactTools": true,
    "maxExpandedArtifacts": 8
  }
}
```

`style` defaults to `"omp"`; use `"classic"` for the prior transcript projection. `userMessageBox` controls only the classic user frame, while `compactTools: false` restores native collapsed tool rows in either style. Runtime toggles are dynamic and file receipts remain available when compact tools are disabled.

Malformed JSON fails closed for this extension and is reported once. `/presentation` changes only the `presentation` section atomically.

## Commands

```text
/presentation                 # TUI configuration menu
/presentation config          # explicit menu entry
/presentation status          # effective config and integration state
/presentation on|off          # master display switch
/presentation style omp|classic
/presentation workspace on|off # workspace entry
/presentation system on|off    # system event entries
/presentation user on|off      # user-message frame
/presentation tools on|off    # compact tool rows
/presentation artifacts on|off
/presentation reset           # restore presentation defaults
```

## Develop

```bash
cd packages/interface/presentation
npm run check
```
