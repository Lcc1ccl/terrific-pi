import type { ContextMode, StatuslineConfig, WidgetId } from "./types.ts";

export type MutationResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };

export type ConfigureUi = {
	select(title: string, items: string[]): Promise<string | undefined>;
	input(title: string, value: string): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
};

export type ConfigureDeps = {
	getConfig(): StatuslineConfig;
	getConfigPath(): string;
	applyConfig(config: StatuslineConfig): MutationResult<void>;
	reloadConfig(): MutationResult<StatuslineConfig>;
	resetConfig(): MutationResult<void>;
	ui: ConfigureUi;
};

export function toggleWidget(widgets: WidgetId[], id: WidgetId): MutationResult<WidgetId[]> {
	const index = widgets.indexOf(id);
	if (index >= 0) {
		if (widgets.length <= 1) {
			return { ok: false, error: "At least one widget must remain enabled" };
		}
		return { ok: true, value: widgets.filter((widget) => widget !== id) };
	}
	return { ok: true, value: [...widgets, id] };
}

export function moveWidget(
	widgets: WidgetId[],
	id: WidgetId,
	direction: "up" | "down",
): MutationResult<WidgetId[]> {
	const index = widgets.indexOf(id);
	if (index < 0) {
		return { ok: false, error: `Widget not enabled: ${id}` };
	}

	const target = direction === "up" ? index - 1 : index + 1;
	if (target < 0) {
		return { ok: false, error: "Already first" };
	}
	if (target >= widgets.length) {
		return { ok: false, error: "Already last" };
	}

	const next = [...widgets];
	const current = next[index]!;
	next[index] = next[target]!;
	next[target] = current;
	return { ok: true, value: next };
}

export function parseContextBarWidth(raw: string): MutationResult<number> {
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) {
		return { ok: false, error: "Width must be an integer from 1 to 40" };
	}
	const value = Number.parseInt(trimmed, 10);
	if (value < 1 || value > 40) {
		return { ok: false, error: "Width must be an integer from 1 to 40" };
	}
	return { ok: true, value };
}

export function parseSeparator(raw: string): MutationResult<string> {
	if (raw.length === 0) {
		return { ok: false, error: "Separator cannot be empty" };
	}
	return { ok: true, value: raw };
}

export function formatConfigSummary(config: StatuslineConfig, configPath: string): string {
	return [
		`widgets: ${config.widgets.join(", ")}`,
		`contextMode: ${config.contextMode}`,
		`contextBarWidth: ${config.contextBarWidth}`,
		`minimal: ${config.minimal}`,
		`separator: ${JSON.stringify(config.separator)}`,
		`config: ${configPath}`,
	].join("\n");
}

function mainMenuTitle(config: StatuslineConfig, configPath: string): string {
	return [
		"Statusline Config",
		`widgets: ${config.widgets.join(", ")}`,
		`contextMode: ${config.contextMode} · bar: ${config.contextBarWidth} · minimal: ${config.minimal}`,
		`separator: ${JSON.stringify(config.separator)}`,
		`config: ${configPath}`,
	].join("\n");
}

function applyOrNotify(
	deps: ConfigureDeps,
	next: StatuslineConfig,
	success: string,
): void {
	const result = deps.applyConfig(next);
	if (!result.ok) {
		deps.ui.notify(result.error, "error");
		return;
	}
	deps.ui.notify(success, "info");
}

async function toggleWidgetsLoop(deps: ConfigureDeps, allWidgets: readonly WidgetId[]): Promise<void> {
	while (true) {
		const config = deps.getConfig();
		const items = [
			...allWidgets.map((id) => `${config.widgets.includes(id) ? "●" : "○"} ${id}`),
			"Back",
		];
		const choice = await deps.ui.select("Toggle widgets", items);
		if (!choice || choice === "Back") return;

		const id = allWidgets.find((widget) => choice === `● ${widget}` || choice === `○ ${widget}`);
		if (!id) continue;

		const toggled = toggleWidget(config.widgets, id);
		if (!toggled.ok) {
			deps.ui.notify(toggled.error, "warning");
			continue;
		}

		applyOrNotify(deps, { ...config, widgets: toggled.value }, `widgets: ${toggled.value.join(", ")}`);
	}
}

async function reorderWidgetsLoop(deps: ConfigureDeps): Promise<void> {
	while (true) {
		const config = deps.getConfig();
		if (config.widgets.length === 0) {
			deps.ui.notify("No widgets to reorder", "warning");
			return;
		}

		const choice = await deps.ui.select("Reorder widgets", [...config.widgets, "Back"]);
		if (!choice || choice === "Back") return;
		if (!config.widgets.includes(choice as WidgetId)) continue;

		const id = choice as WidgetId;
		const action = await deps.ui.select(`Move ${id}`, ["Move up", "Move down", "Back"]);
		if (!action || action === "Back") continue;

		const moved = moveWidget(config.widgets, id, action === "Move up" ? "up" : "down");
		if (!moved.ok) {
			deps.ui.notify(moved.error, "warning");
			continue;
		}

		applyOrNotify(deps, { ...config, widgets: moved.value }, `order: ${moved.value.join(", ")}`);
	}
}

async function setContextMode(deps: ConfigureDeps): Promise<void> {
	const config = deps.getConfig();
	const choice = await deps.ui.select("Context mode", ["remaining", "used", "Back"]);
	if (!choice || choice === "Back") return;
	if (choice !== "remaining" && choice !== "used") return;

	const contextMode = choice as ContextMode;
	if (contextMode === config.contextMode) {
		deps.ui.notify(`contextMode already ${contextMode}`, "info");
		return;
	}

	applyOrNotify(deps, { ...config, contextMode }, `contextMode: ${contextMode}`);
}

async function setContextBarWidth(deps: ConfigureDeps): Promise<void> {
	const config = deps.getConfig();
	const raw = await deps.ui.input("Context bar width (1-40)", String(config.contextBarWidth));
	if (raw === undefined) return;

	const parsed = parseContextBarWidth(raw);
	if (!parsed.ok) {
		deps.ui.notify(parsed.error, "error");
		return;
	}

	applyOrNotify(deps, { ...config, contextBarWidth: parsed.value }, `contextBarWidth: ${parsed.value}`);
}

async function setMinimalMode(deps: ConfigureDeps): Promise<void> {
	const config = deps.getConfig();
	const choice = await deps.ui.select("Minimal mode", ["on", "off", "Back"]);
	if (!choice || choice === "Back") return;

	const minimal = choice === "on";
	if (minimal === config.minimal) {
		deps.ui.notify(`minimal already ${minimal}`, "info");
		return;
	}

	applyOrNotify(deps, { ...config, minimal }, `minimal: ${minimal}`);
}

async function setSeparator(deps: ConfigureDeps): Promise<void> {
	const config = deps.getConfig();
	const raw = await deps.ui.input("Separator", config.separator);
	if (raw === undefined) return;

	const parsed = parseSeparator(raw);
	if (!parsed.ok) {
		deps.ui.notify(parsed.error, "error");
		return;
	}

	applyOrNotify(deps, { ...config, separator: parsed.value }, `separator: ${JSON.stringify(parsed.value)}`);
}

export async function runStatuslineConfigurator(
	deps: ConfigureDeps,
	allWidgets: readonly WidgetId[],
): Promise<void> {
	while (true) {
		const config = deps.getConfig();
		const configPath = deps.getConfigPath();
		const choice = await deps.ui.select(mainMenuTitle(config, configPath), [
			"Toggle widgets",
			"Reorder widgets",
			"Context mode",
			"Context bar width",
			"Minimal mode",
			"Separator",
			"Show config",
			"Reload from file",
			"Reset to defaults",
			"Done",
		]);

		if (!choice || choice === "Done") return;

		switch (choice) {
			case "Toggle widgets":
				await toggleWidgetsLoop(deps, allWidgets);
				break;
			case "Reorder widgets":
				await reorderWidgetsLoop(deps);
				break;
			case "Context mode":
				await setContextMode(deps);
				break;
			case "Context bar width":
				await setContextBarWidth(deps);
				break;
			case "Minimal mode":
				await setMinimalMode(deps);
				break;
			case "Separator":
				await setSeparator(deps);
				break;
			case "Show config":
				deps.ui.notify(formatConfigSummary(config, configPath), "info");
				break;
			case "Reload from file": {
				const reloaded = deps.reloadConfig();
				if (!reloaded.ok) {
					deps.ui.notify(reloaded.error, "error");
					break;
				}
				deps.ui.notify(`Reloaded (${reloaded.value.widgets.join(", ")})`, "info");
				break;
			}
			case "Reset to defaults": {
				const reset = deps.resetConfig();
				if (!reset.ok) {
					deps.ui.notify(reset.error, "error");
					break;
				}
				deps.ui.notify("Reset to defaults", "info");
				break;
			}
			default:
				break;
		}
	}
}
