# appearance

Source-only Pi package for a static startup header, a rounded `CustomEditor`, and `/appearance` settings stored in `terrific.json.appearance`.

Through Phase 6, `terrificPi.install` is `false`: source and attribution ship in the archive, but the package does not enter the install manifest or live packages. Enabling it and retiring any existing editor owner are separate Phase 7 rollout actions.

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

- `appearance` owns only `setHeader` and `setEditorComponent`; `statusline` remains the sole footer owner, Taskboard owns task HUD/status, and Presentation owns transcript renderers.
- Absent, malformed, disabled, or non-TUI configuration has zero UI side effects. An existing foreign editor owner makes editor-enabled startup fail closed without installing the header.
- Phase 7 must retire `npm:pi-vision-handoff@0.8.1` before enabling this package; package order is not conflict resolution.
- Appearance replaces only the editor surface. It does not implement `/vision-handoff`, paste-time prewarm, non-visual-model vision transfer, or the auxiliary vision usage bridge.

Derived portions are attributed in `LICENSES/pi-open-tui-MIT.txt`.
