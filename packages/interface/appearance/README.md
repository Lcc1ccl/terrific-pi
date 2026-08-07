# appearance

Installable Pi package for a static startup header, a rounded `CustomEditor`, two editor-border status slots, and `/appearance` settings stored in `terrific.json.appearance`.

The root `terrific-pi` package loads this component. The UI remains fail-closed until a valid `terrific.json.appearance` section enables it; package installation does not modify live Pi JSON.

Configuration is fail-closed and global-only:

```json
{
  "appearance": {
    "enabled": true,
    "settingsLanguage": "en",
    "header": true,
    "editor": true
  }
}
```

Changes made by `/appearance` are written atomically and take effect after `/reload`.

## Ownership and rollout

- `appearance` owns only `setHeader` and `setEditorComponent`; `statusline` remains the sole status-widget/footer owner, Taskboard owns task HUD/status, and Presentation owns transcript renderers.
- After Appearance successfully owns the editor, it requests a width-aware status renderer over `terrific-pi:statusline:editor-v2`. Statusline `LINE0` renders at the editor top-left and `LINE1` at the bottom-right, each with its own width budget; neither is duplicated in the footer.
- The bridge adds no configuration: `/statusline` controls all five lines, widget enablement/order, separator, and icon mode, while the host theme supplies colors. Disabled Appearance or an editor conflict renders all configured lines through the footer in order.
- Absent, malformed, disabled, or non-TUI configuration has zero UI side effects. An existing foreign editor owner makes editor-enabled startup fail closed without installing the header.
- Package load order is not used as conflict resolution; Appearance fails closed when another editor owner is already active.
- Appearance replaces only the editor surface. Rollout loses `/vision-handoff`, paste-time prewarm, non-visual-model vision transfer, and the auxiliary vision usage bridge; none is replaced by Appearance.

Derived portions are attributed in `LICENSES/pi-open-tui-MIT.txt`.
