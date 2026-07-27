# Appearance

Native Pi TUI appearance shell enabled only by this global configuration in `$PI_CODING_AGENT_DIR/terrific.json`:

```json
{
  "appearance": {
    "profile": "terrific-native-v1"
  }
}
```

The package provides the `terrific-night` theme plus a neutral header, bordered `CustomEditor`, and responsive shortcuts row. It rereads the profile on session start and before each request, so external edits take effect without reloading Pi. It uses Pi's official public extension and TUI APIs and has no runtime dependencies.

The visual direction uses two fixed, public references: [Grok Build's GrokNight renderer](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/crates/codegen/xai-grok-pager-render/src/theme/groknight.rs), distributed under [Apache-2.0](https://github.com/xai-org/grok-build/blob/3af4d5d39897855bdcc74f23e690024a5dc05573/LICENSE), for observed dark-surface conventions; and the [Tokyo Night palette](https://github.com/enkia/tokyo-night-vscode-theme/blob/7c0f11eaef322f293621ca7befe462214b7ea468/themes/tokyo-night-color-theme.json), distributed under [MIT](https://github.com/enkia/tokyo-night-vscode-theme/blob/7c0f11eaef322f293621ca7befe462214b7ea468/LICENSE.txt), for semantic color relationships.

These are visual and palette references only. The frozen palette is an original Terrific mapping for Pi's public theme tokens. This package copies no referenced code, assets, or logos and implies no affiliation or endorsement. No third-party runtime code is included.
