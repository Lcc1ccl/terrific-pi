# Live Model TUI Verification

- Runtime: Pi `0.81.1`, `presentation` loaded through its guarded native render compatibility layer; model `openai/gpt-5.4-mini` at `minimal` thinking.
- Isolation: a temporary native-WSL workspace, session directory, and agent directory were used. Authentication was copied only for the process lifetime and was neither read, logged, nor archived.
- Sanitization: capture paths use `<fixture>` in place of the temporary workspace. ANSI control sequences, tmux warnings, credentials, and machine-local paths were removed before this directory was written.
- Dimensions: each capture is one visible tmux pane at `80x24`, `120x40`, or `160x50`, in both collapsed and `app.tools.expand` states.

## Captured Gates

| Gate | Capture prefix | Evidence |
|---|---|---|
| Read/search/list exploration | `read-*` | One semantic `Explored` row collapsed; native read/grep/ls output plus semantic detail expanded. |
| File mutation receipts | `edit-write-*` | Collapsed receipts show impact only; raw write/edit content remains absent. |
| Bash error | `bash-error-*` | Exactly one collapsed failure row with `exit 7`; expanded view exposes the native command/result. |
| Process task | `process-task-*` | `process_update` and the waiting task panel survive the live model turn. |
| Exact Skill load | `skill-load-*` | Registered `SKILL.md` read becomes `Skill(live-skill) · loaded`; an ordinary source read remains exploration. |
| Reload/resume | `reload-*`, `resume-*` | The semantic exploration row and native expansion survive `/reload` and a fresh Pi process resuming the same session. |

## Automated Assertions

The capture audit verified all 42 panes for:

- the declared terminal width, using Pi TUI `visibleWidth`;
- no `Working` residue, Skill registration conflict, absolute local path, bearer header, or token-shaped value;
- collapsed/expanded disclosure behavior, including no stale `to expand` hint in expanded view;
- one bash failure row, safe `exit 7` reasoning, named Skill entry, file receipt privacy, and reload/resume history.

The 80-column exploration line deliberately truncates the low-value summary before its dynamic `ctrl+o to expand` suffix. This preserves the keyboard-accessible disclosure path at the narrowest target width.
