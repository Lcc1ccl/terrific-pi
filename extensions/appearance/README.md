# appearance

Installable Pi package for a static startup header, a rounded `CustomEditor`, and `/appearance` settings stored in `terrific.json.appearance`.

Phase 7 includes this package in the install manifest. Installation only adds the package entry; the UI remains fail-closed until a valid `terrific.json.appearance` section enables it. This repository switch does not modify live Pi JSON or snapshot content.

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
- Phase 7 retires `npm:pi-vision-handoff@0.8.1`; installer package merging removes the old pin before enabling this package, so package order is not conflict resolution.
- Appearance replaces only the editor surface. Rollout loses `/vision-handoff`, paste-time prewarm, non-visual-model vision transfer, and the auxiliary vision usage bridge; none is replaced by Appearance.

Derived portions are attributed in `LICENSES/pi-open-tui-MIT.txt`.
