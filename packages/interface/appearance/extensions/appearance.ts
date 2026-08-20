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

const EDITOR_STATUS_EVENT = "terrific-pi:statusline:editor-v2";

type EditorStatusSource = {
  render(line: "line0" | "line1", width: number): string;
};

type EditorStatusRequest = {
  version: 2;
  active: boolean;
  attach?: (source: EditorStatusSource) => void;
  ownsEditor?: () => boolean;
};

function isTui(ctx: ExtensionContext): boolean {
  return ctx.hasUI && ctx.mode === "tui";
}

export default function appearance(pi: ExtensionAPI): void {
  let editorTui: { requestRender(): void } | undefined;
  let editorUi: ExtensionContext["ui"] | undefined;
  let statusSource: EditorStatusSource | undefined;
  let bridgeRequested = false;
  let configErrorNotified = false;
  const reportConfigError = (ctx: ExtensionContext, error: string): void => {
    if (configErrorNotified) return;
    configErrorNotified = true;
    ctx.ui.notify(`Appearance disabled: ${error}`, "warning");
  };
  const editorFactory: NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]> =
    (tui, theme, keybindings) => {
      editorTui = tui;
      if (!bridgeRequested && editorUi) {
        bridgeRequested = true;
        const ownerUi = editorUi;
        pi.events.emit(EDITOR_STATUS_EVENT, {
          version: 2,
          active: true,
          ownsEditor: () => ownerUi.getEditorComponent() === editorFactory,
          attach(source) {
            statusSource = source;
            editorTui?.requestRender();
          },
        } satisfies EditorStatusRequest);
      }
      return new AppearanceEditor(
        tui,
        theme,
        keybindings,
        (width) => statusSource?.render("line0", width) ?? "",
        (width) => statusSource?.render("line1", width) ?? "",
      );
    };

  pi.on("session_start", async (_event, ctx) => {
    if (!isTui(ctx)) return;
    const loaded = loadAppearanceConfig(getAgentDir());
    if (loaded.error) {
      reportConfigError(ctx, loaded.error);
      return;
    }
    const config = loaded.config;
    if (!config?.enabled) return;

    const owner = ctx.ui.getEditorComponent();
    if (config.editor && owner !== undefined && owner !== editorFactory) {
      ctx.ui.notify("Appearance disabled: custom editor owner conflict; remove the foreign editor and /reload.", "warning");
      return;
    }

    if (config.header) ctx.ui.setHeader((tui) => new AppearanceHeader(pi, ctx, tui));
    if (config.editor) {
      editorUi = ctx.ui;
      ctx.ui.setEditorComponent(editorFactory);
    }
  });

  pi.on("session_shutdown", async () => {
    if (bridgeRequested) pi.events.emit(EDITOR_STATUS_EVENT, { version: 2, active: false } satisfies EditorStatusRequest);
    bridgeRequested = false;
    statusSource = undefined;
    editorTui = undefined;
    editorUi = undefined;
    // Host teardown owns editor/header disposal. Clearing here can erase a newer owner during reload.
  });

  pi.registerCommand("appearance", {
    description: "Configure the appearance header and editor",
    handler: async (_args, ctx) => {
      if (!isTui(ctx)) return;
      const loaded = loadAppearanceConfig(getAgentDir());
      if (loaded.error) {
        reportConfigError(ctx, loaded.error);
        return;
      }
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
