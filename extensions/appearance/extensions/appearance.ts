import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;
type HeaderFactory = NonNullable<Parameters<ExtensionUIContext["setHeader"]>[0]>;

import { readAppearanceConfig } from "../lib/config.ts";
import { TerrificEditor } from "../lib/editor.ts";
import { createTerrificHeader } from "../lib/header.ts";
import { SHORTCUT_WIDGET_KEY, createShortcutsWidget } from "../lib/shortcuts.ts";

interface Owner {
  generation: number;
  headerFactory: HeaderFactory;
  editorFactory?: EditorFactory;
  previousEditor?: EditorFactory;
}

let nextGeneration = 0;
const owners = new WeakMap<ExtensionUIContext, Owner>();
const appearanceFactories = new WeakSet<EditorFactory>();

export default function appearance(pi: ExtensionAPI): void {
  let activeOwner: { ui: ExtensionUIContext; owner: Owner; widgetMounted: boolean } | undefined;
  let malformedNotified = false;
  let conflictNotified = false;

  const deactivate = (): void => {
    const active = activeOwner;
    if (!active || owners.get(active.ui)?.generation !== active.owner.generation) return;
    owners.delete(active.ui);
    if (active.widgetMounted) active.ui.setWidget(SHORTCUT_WIDGET_KEY, undefined, { placement: "belowEditor" });
    active.ui.setHeader(undefined);
    if (active.owner.editorFactory && active.ui.getEditorComponent() === active.owner.editorFactory) {
      active.ui.setEditorComponent(active.owner.previousEditor);
    }
    activeOwner = undefined;
  };

  const sync = (ctx: { mode: string; ui: ExtensionUIContext }): void => {
    if (ctx.mode !== "tui") return;
    const config = readAppearanceConfig();
    if (!config.active) {
      deactivate();
      if (config.error && !malformedNotified) {
        malformedNotified = true;
        ctx.ui.notify(config.error, "warning");
      }
      return;
    }
    malformedNotified = false;
    if (activeOwner && owners.get(activeOwner.ui)?.generation === activeOwner.owner.generation) return;

    const ui = ctx.ui;
    const generation = ++nextGeneration;
    const headerFactory: HeaderFactory = (tui, theme) => createTerrificHeader(tui, theme);
    ui.setHeader(headerFactory);
    const current = ui.getEditorComponent();
    if (current && !appearanceFactories.has(current)) {
      const owner = { generation, headerFactory };
      owners.set(ui, owner);
      activeOwner = { ui, owner, widgetMounted: false };
      if (!conflictNotified) {
        conflictNotified = true;
        ui.notify("Terrific appearance kept the existing custom editor", "warning");
      }
      return;
    }

    const previousEditor = current ? owners.get(ui)?.previousEditor : undefined;
    let widgetMounted = false;
    const factory: EditorFactory = (tui, theme, keybindings) => {
      const live = owners.get(ui);
      if (live?.generation === generation && !widgetMounted) {
        widgetMounted = true;
        if (activeOwner?.owner.generation === generation) activeOwner.widgetMounted = true;
        ui.setWidget(
          SHORTCUT_WIDGET_KEY,
          (widgetTui, widgetTheme) => createShortcutsWidget(widgetTui, widgetTheme, keybindings),
          { placement: "belowEditor" },
        );
      }
      return new TerrificEditor(tui, theme, keybindings);
    };
    appearanceFactories.add(factory);
    const owner = { generation, headerFactory, editorFactory: factory, previousEditor };
    owners.set(ui, owner);
    activeOwner = { ui, owner, widgetMounted };
    ui.setEditorComponent(factory);
  };

  pi.on("session_start", (_event, ctx) => sync(ctx));
  pi.on("before_agent_start", (_event, ctx) => sync(ctx));
  pi.on("session_shutdown", () => deactivate());
}
