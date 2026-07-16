import type { ContextMode, StatuslineConfig, WidgetId } from "./types.ts";

export type MutationResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };

export type WidgetEditorItem = {
	id: WidgetId;
	enabled: boolean;
};

export type ConfigureUi = {
	select(title: string, items: string[]): Promise<string | undefined>;
	input(title: string, value: string): Promise<string | undefined>;
	/** Codex-style multi-select: Space toggle, ↑/↓ select, ←/→ move. */
	editWidgets(
		title: string,
		allWidgets: readonly WidgetId[],
		enabled: WidgetId[],
		onChange: (enabled: WidgetId[]) => void,
		onReject?: (error: string) => void,
	): Promise<WidgetId[] | undefined>;
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

/** Swap item at index with neighbor. Returns undefined if out of bounds. */
export function swapAdjacent<T>(
	items: readonly T[],
	index: number,
	delta: -1 | 1,
): { items: T[]; index: number } | undefined {
	const target = index + delta;
	if (index < 0 || index >= items.length || target < 0 || target >= items.length) {
		return undefined;
	}
	const next = [...items];
	const current = next[index]!;
	next[index] = next[target]!;
	next[target] = current;
	return { items: next, index: target };
}

/** Enabled widgets first (config order), then disabled (catalog order). */
export function buildWidgetEditorItems(
	enabled: readonly string[],
	allWidgets: readonly string[],
): WidgetEditorItem[] {
	const allSet = new Set(allWidgets);
	const seen = new Set<string>();
	const items: WidgetEditorItem[] = [];

	for (const id of enabled) {
		if (!allSet.has(id) || seen.has(id)) continue;
		seen.add(id);
		items.push({ id: id as WidgetId, enabled: true });
	}
	for (const id of allWidgets) {
		if (seen.has(id)) continue;
		seen.add(id);
		items.push({ id: id as WidgetId, enabled: false });
	}
	return items;
}

export function enabledFromEditorItems(items: readonly WidgetEditorItem[]): WidgetId[] {
	return items.filter((item) => item.enabled).map((item) => item.id);
}

export function toggleEditorItem(
	items: readonly WidgetEditorItem[],
	index: number,
): MutationResult<WidgetEditorItem[]> {
	const current = items[index];
	if (!current) {
		return { ok: false, error: "Invalid selection" };
	}

	if (current.enabled) {
		const enabledCount = items.reduce((n, item) => n + (item.enabled ? 1 : 0), 0);
		if (enabledCount <= 1) {
			return { ok: false, error: "At least one widget must remain enabled" };
		}
	}

	const next = items.map((item, i) =>
		i === index ? { ...item, enabled: !item.enabled } : item,
	);
	return { ok: true, value: next };
}

export function moveEditorItem(
	items: readonly WidgetEditorItem[],
	index: number,
	delta: -1 | 1,
): MutationResult<{ items: WidgetEditorItem[]; index: number }> {
	const swapped = swapAdjacent(items, index, delta);
	if (!swapped) {
		return { ok: false, error: delta < 0 ? "Already first" : "Already last" };
	}
	return { ok: true, value: swapped };
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

	const swapped = swapAdjacent(widgets, index, direction === "up" ? -1 : 1);
	if (!swapped) {
		return { ok: false, error: direction === "up" ? "Already first" : "Already last" };
	}
	return { ok: true, value: swapped.items };
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

async function editWidgetsLoop(deps: ConfigureDeps, allWidgets: readonly WidgetId[]): Promise<void> {
	const config = deps.getConfig();
	await deps.ui.editWidgets(
		"Widgets",
		allWidgets,
		[...config.widgets],
		(widgets) => {
			const current = deps.getConfig();
			applyOrNotify(deps, { ...current, widgets }, `widgets: ${widgets.join(", ")}`);
		},
		(error) => deps.ui.notify(error, "warning"),
	);
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
			"Widgets",
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
			case "Widgets":
				await editWidgetsLoop(deps, allWidgets);
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
