import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { AppearanceEditor } from "../lib/editor.ts";
import { AppearanceHeader } from "../lib/header.ts";
import {
  DEFAULT_APPEARANCE_SETTINGS,
  loadAppearanceConfig,
  writeAppearanceSection,
} from "../lib/config.ts";
import { createAppearanceSettings } from "../lib/settings.ts";

function isTui(ctx: ExtensionContext): boolean {
  return ctx.hasUI && ctx.mode === "tui";
}

export default function appearance(pi: ExtensionAPI): void {
  const editorFactory: NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]> =
    (tui, theme, keybindings) => new AppearanceEditor(tui, theme, keybindings);

  pi.on("session_start", async (_event, ctx) => {
    if (!isTui(ctx)) return;
    const loaded = loadAppearanceConfig(getAgentDir());
    const config = loaded.config;
    if (!config?.enabled) return;

    const owner = ctx.ui.getEditorComponent();
    if (config.editor && owner !== undefined && owner !== editorFactory) {
      ctx.ui.notify("Appearance disabled: custom editor owner conflict; remove the foreign editor and /reload.", "warning");
      return;
    }

    if (config.header) ctx.ui.setHeader((tui) => new AppearanceHeader(pi, ctx, tui));
    if (config.editor) ctx.ui.setEditorComponent(editorFactory);
  });

  pi.on("session_shutdown", async () => {
    // Host teardown owns editor/header disposal. Clearing here can erase a newer owner during reload.
  });

  pi.registerCommand("appearance", {
    description: "Configure the appearance header and editor",
    handler: async (_args, ctx) => {
      if (!isTui(ctx)) return;
      const loaded = loadAppearanceConfig(getAgentDir());
      const initial = loaded.config ?? DEFAULT_APPEARANCE_SETTINGS;
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => createAppearanceSettings(
        theme,
        initial,
        (next) => {
          const result = writeAppearanceSection(next, getAgentDir());
          if (result.ok) ctx.ui.notify("Appearance saved. Run /reload to apply the new owner settings.", "info");
          else ctx.ui.notify(`Appearance was not saved: ${result.error}`, "error");
          tui.requestRender();
        },
        () => done(undefined),
      ), { overlay: true });
    },
  });
}
