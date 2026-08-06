import {
	cloneMinimalProfile,
	DEFAULT_CONFIG,
	DEFAULT_CONTEXT_BAR_WIDTH,
	DEFAULT_WIDGET_SPACING,
	isMinimalProfile,
	MAX_CONTEXT_BAR_WIDTH,
	MAX_WIDGET_SPACING,
	MIN_CONTEXT_BAR_WIDTH,
	MIN_WIDGET_SPACING,
	MINIMAL_PROFILE,
	resolveWidgetGroup,
	WIDGET_SEPARATOR_GLYPHS,
	withWidgetGroupOverride,
} from "./config.ts";
import type {
	ContextMode,
	IconMode,
	StatuslineConfig,
	StatuslineLayout,
	StatuslineSeparator,
	ToolActivityMode,
	WidgetGroup,
	WidgetId,
} from "./types.ts";
import { WIDGET_GROUP_ORDER } from "./types.ts";

export type MutationResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };

export type WidgetEditorItem = {
	id: WidgetId;
	enabled: boolean;
};

export type WidgetEditorAction = "cancel" | "done" | "up" | "down" | "left" | "right" | "toggle";

export type WidgetEditorBinding =
	| "tui.select.cancel"
	| "tui.select.confirm"
	| "tui.select.up"
	| "tui.select.down"
	| "tui.editor.cursorLeft"
	| "tui.editor.cursorRight";

export function widgetEditorAction(
	data: string,
	keybindings: { matches(data: string, binding: WidgetEditorBinding): boolean },
): WidgetEditorAction | undefined {
	if (keybindings.matches(data, "tui.select.cancel")) return "cancel";
	if (keybindings.matches(data, "tui.select.confirm")) return "done";
	if (keybindings.matches(data, "tui.select.up") || data === "k") return "up";
	if (keybindings.matches(data, "tui.select.down") || data === "j") return "down";
	if (keybindings.matches(data, "tui.editor.cursorLeft") || data === "h") return "left";
	if (keybindings.matches(data, "tui.editor.cursorRight") || data === "l") return "right";
	if (data === " ") return "toggle";
	return undefined;
}

export type ConfigureUi = {
	/** Top-level selector backed by a wrapping SelectList. */
	selectMain(title: string, items: string[]): Promise<string | undefined>;
	select(title: string, items: string[]): Promise<string | undefined>;
	input(title: string, initialValue: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	/** Codex-style multi-select: Space toggle, g cycle group, ↑/↓ select, ←/→ move. */
	editWidgets(
		title: string,
		allWidgets: readonly WidgetId[],
		enabled: WidgetId[],
		widgetGroups: StatuslineConfig["widgetGroups"],
		onChange: (enabled: WidgetId[], widgetGroups: StatuslineConfig["widgetGroups"]) => boolean,
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

export function widgetGroupOf(
	id: string,
	overrides?: StatuslineConfig["widgetGroups"],
): WidgetGroup {
	return resolveWidgetGroup(id as WidgetId, overrides);
}

/** Widgets in stacked visual order: project → usage → environment → activity. */
export function flattenByGroup(
	order: readonly string[],
	overrides?: StatuslineConfig["widgetGroups"],
): WidgetId[] {
	const out: WidgetId[] = [];
	const seen = new Set<string>();
	for (const group of WIDGET_GROUP_ORDER) {
		for (const id of order) {
			if (seen.has(id)) continue;
			if (resolveWidgetGroup(id as WidgetId, overrides) !== group) continue;
			seen.add(id);
			out.push(id as WidgetId);
		}
	}
	return out;
}

/** @deprecated alias — enabled-only lists still use the same flatten. */
export function flattenEnabledByGroup(
	enabled: readonly string[],
	overrides?: StatuslineConfig["widgetGroups"],
): WidgetId[] {
	return flattenByGroup(enabled, overrides);
}

/**
 * Move any widget (enabled or not) along partition visual order.
 *
 * Model: one linear order of all widgets + per-widget group. Visual list is
 * group-major; each partition is a contiguous range.
 *
 * - Same partition: swap with the neighbor.
 * - Cross right: become destination partition's **first**.
 * - Cross left: become destination partition's **last**.
 */
export function moveInGroups(
	order: readonly string[],
	overrides: StatuslineConfig["widgetGroups"] | undefined,
	id: string,
	delta: -1 | 1,
): { order: WidgetId[]; widgetGroups: StatuslineConfig["widgetGroups"] } | undefined {
	const visual = flattenByGroup(order, overrides);
	const index = visual.indexOf(id as WidgetId);
	if (index < 0) return undefined;
	const target = index + delta;
	if (target < 0 || target >= visual.length) return undefined;

	const item = visual[index]!;
	const currentGroup = resolveWidgetGroup(item, overrides);
	const neighborGroup = resolveWidgetGroup(visual[target]!, overrides);

	if (neighborGroup === currentGroup) {
		const nextVisual = [...visual];
		nextVisual[index] = nextVisual[target]!;
		nextVisual[target] = item;
		return { order: nextVisual, widgetGroups: overrides };
	}

	const destGroup = neighborGroup;
	const without = visual.filter((_, i) => i !== index);
	const destIndexes = without
		.map((widget, i) => (resolveWidgetGroup(widget, overrides) === destGroup ? i : -1))
		.filter((i) => i >= 0);

	let insertAt: number;
	if (destIndexes.length === 0) {
		insertAt = delta > 0 ? without.length : 0;
	} else if (delta > 0) {
		insertAt = destIndexes[0]!;
	} else {
		insertAt = destIndexes[destIndexes.length - 1]! + 1;
	}

	const nextVisual = [...without];
	nextVisual.splice(insertAt, 0, item);
	const widgetGroups = withWidgetGroupOverride(overrides, item, destGroup);
	return { order: nextVisual, widgetGroups };
}

/** @deprecated use moveInGroups */
export function moveEnabledInGroups(
	enabled: readonly string[],
	overrides: StatuslineConfig["widgetGroups"] | undefined,
	id: string,
	delta: -1 | 1,
): { enabled: WidgetId[]; widgetGroups: StatuslineConfig["widgetGroups"] } | undefined {
	const moved = moveInGroups(enabled, overrides, id, delta);
	if (!moved) return undefined;
	return { enabled: moved.order, widgetGroups: moved.widgetGroups };
}

/** Initial full catalog order: enabled (config order) then remaining catalog ids. */
export function initialWidgetOrder(
	enabled: readonly string[],
	allWidgets: readonly string[],
): WidgetId[] {
	const allSet = new Set(allWidgets);
	const seen = new Set<string>();
	const order: WidgetId[] = [];
	for (const id of enabled) {
		if (!allSet.has(id) || seen.has(id)) continue;
		seen.add(id);
		order.push(id as WidgetId);
	}
	for (const id of allWidgets) {
		if (seen.has(id)) continue;
		seen.add(id);
		order.push(id as WidgetId);
	}
	return order;
}

/**
 * Editor rows by partition using full order (enabled and disabled interleave by order).
 */
export function buildWidgetEditorItems(
	enabled: readonly string[],
	allWidgets: readonly string[],
	overrides?: StatuslineConfig["widgetGroups"],
	order: readonly string[] = initialWidgetOrder(enabled, allWidgets),
): WidgetEditorItem[] {
	const allSet = new Set(allWidgets);
	const enabledSet = new Set(
		enabled.filter((id, index) => allSet.has(id) && enabled.indexOf(id) === index),
	);
	const ordered = flattenByGroup(
		order.filter((id) => allSet.has(id)),
		overrides,
	);
	const seen = new Set(ordered);
	const items: WidgetEditorItem[] = ordered.map((id) => ({
		id,
		enabled: enabledSet.has(id),
	}));
	// Any catalog id missing from order (shouldn't happen) append by group defaults.
	for (const group of WIDGET_GROUP_ORDER) {
		for (const id of allWidgets) {
			if (seen.has(id as WidgetId)) continue;
			if (resolveWidgetGroup(id as WidgetId, overrides) !== group) continue;
			seen.add(id as WidgetId);
			items.push({ id: id as WidgetId, enabled: enabledSet.has(id) });
		}
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

export function formatSettingChoices<T extends string>(
	values: readonly T[],
	current: T,
	defaultValue: T,
): string[] {
	return [...values]
		.sort((left, right) => Number(right === current) - Number(left === current))
		.map((value) => {
			const markers = [value === current ? "[current]" : "", value === defaultValue ? "[default]" : ""]
				.filter(Boolean)
				.join(" ");
			return markers ? `${value} ${markers}` : value;
		});
}

async function selectSetting<T extends string>(
	deps: ConfigureDeps,
	title: string,
	values: readonly T[],
	current: T,
	defaultValue: T,
): Promise<T | undefined> {
	const choice = await deps.ui.select(title, [...formatSettingChoices(values, current, defaultValue), "Back"]);
	if (!choice || choice === "Back") return undefined;
	return values.find((value) => choice === value || choice.startsWith(`${value} [`));
}

export function parseContextBarWidth(raw: string): MutationResult<number> {
	const trimmed = raw.trim();
	const error = `Width must be an integer from ${MIN_CONTEXT_BAR_WIDTH} to ${MAX_CONTEXT_BAR_WIDTH} (default ${DEFAULT_CONTEXT_BAR_WIDTH})`;
	if (!/^\d+$/.test(trimmed)) return { ok: false, error };
	const value = Number.parseInt(trimmed, 10);
	return value >= MIN_CONTEXT_BAR_WIDTH && value <= MAX_CONTEXT_BAR_WIDTH
		? { ok: true, value }
		: { ok: false, error };
}

export function parseWidgetSpacing(raw: string): MutationResult<number> {
	const trimmed = raw.trim();
	const error = `Spacing must be an integer from ${MIN_WIDGET_SPACING} to ${MAX_WIDGET_SPACING} (default ${DEFAULT_WIDGET_SPACING})`;
	if (!/^\d+$/.test(trimmed)) return { ok: false, error };
	const value = Number.parseInt(trimmed, 10);
	return value >= MIN_WIDGET_SPACING && value <= MAX_WIDGET_SPACING
		? { ok: true, value }
		: { ok: false, error };
}

function separatorLabel(separator: StatuslineSeparator | undefined): string {
	const value = separator ?? DEFAULT_CONFIG.separator;
	return `${value} (${WIDGET_SEPARATOR_GLYPHS[value]})`;
}

export function formatConfigSummary(config: StatuslineConfig, configPath: string): string {
	return [
		`widgets: ${config.widgets.join(", ")}`,
		`layout: ${config.layout}`,
		`iconMode: ${config.iconMode}`,
		`contextMode: ${config.contextMode}`,
		`contextBarWidth: ${config.contextBarWidth} (default ${DEFAULT_CONTEXT_BAR_WIDTH}, min ${MIN_CONTEXT_BAR_WIDTH}, max ${MAX_CONTEXT_BAR_WIDTH})`,
		`minimal: ${config.minimal}${isMinimalProfile(config) ? " (profile)" : config.minimal ? " (abbr labels)" : ""}`,
		`telemetry: ${(config.telemetry ?? DEFAULT_CONFIG.telemetry!).display}`,
		`toolActivityMode: ${config.toolActivityMode}`,
		`separator: ${separatorLabel(config.separator)}`,
		`spacing: ${config.spacing} (default ${DEFAULT_WIDGET_SPACING}, min ${MIN_WIDGET_SPACING}, max ${MAX_WIDGET_SPACING})`,
		`config: ${configPath}`,
	].join("\n");
}

function mainMenuTitle(config: StatuslineConfig, configPath: string): string {
	const minimalLabel = isMinimalProfile(config)
		? "profile"
		: config.minimal
			? "abbr labels"
			: "off";
	return [
		"Statusline Config",
		`widgets: ${config.widgets.join(", ")}`,
		`layout: ${config.layout} · iconMode: ${config.iconMode} · separator: ${separatorLabel(config.separator)} · spacing: ${config.spacing}`,
		`contextMode: ${config.contextMode} · bar: ${config.contextBarWidth} · toolActivityMode: ${config.toolActivityMode}`,
		`minimal: ${minimalLabel}`,
		`config: ${configPath}`,
	].join("\n");
}

function applyOrNotify(
	deps: ConfigureDeps,
	next: StatuslineConfig,
	success: string,
): boolean {
	const result = deps.applyConfig(next);
	if (!result.ok) {
		deps.ui.notify(result.error, "error");
		return false;
	}
	deps.ui.notify(success, "info");
	return true;
}

async function editWidgetsLoop(deps: ConfigureDeps, allWidgets: readonly WidgetId[]): Promise<void> {
	const config = deps.getConfig();
	await deps.ui.editWidgets(
		"Widgets",
		allWidgets,
		[...config.widgets],
		config.widgetGroups,
		(widgets, widgetGroups) => {
			const current = deps.getConfig();
			const next: StatuslineConfig = { ...current, widgets };
			if (widgetGroups && Object.keys(widgetGroups).length > 0) next.widgetGroups = widgetGroups;
			else delete next.widgetGroups;
			return applyOrNotify(
				deps,
				next,
				`widgets: ${widgets.join(", ")}${widgetGroups && Object.keys(widgetGroups).length > 0 ? " · groups updated" : ""}`,
			);
		},
		(error) => deps.ui.notify(error, "warning"),
	);
}

async function setLayout(deps: ConfigureDeps): Promise<void> {
	const config = deps.getConfig();
	const layout = await selectSetting(
		deps,
		"Layout — single line, or stacked HUD rows (project/usage/env/activity)",
		["single", "stacked"] satisfies readonly StatuslineLayout[],
		config.layout,
		DEFAULT_CONFIG.layout,
	);
	if (!layout) return;
	if (layout === config.layout) {
		deps.ui.notify(`layout already ${layout}`, "info");
		return;
	}
	applyOrNotify(deps, { ...config, layout }, `layout: ${layout}`);
}

async function setIconMode(deps: ConfigureDeps): Promise<void> {
	const config = deps.getConfig();
	const iconMode = await selectSetting(
		deps,
		"Icon mode — emoji/plain compatibility, Nerd Font, ASCII, or auto detection",
		["emoji", "plain", "nerd", "ascii", "auto"] satisfies readonly IconMode[],
		config.iconMode,
		DEFAULT_CONFIG.iconMode,
	);
	if (!iconMode) return;
	if (iconMode === config.iconMode) {
		deps.ui.notify(`iconMode already ${iconMode}`, "info");
		return;
	}
	applyOrNotify(deps, { ...config, iconMode }, `iconMode: ${iconMode}`);
}

async function setWidgetSeparator(deps: ConfigureDeps): Promise<void> {
	const config = deps.getConfig();
	const current = config.separator ?? DEFAULT_CONFIG.separator;
	const separator = await selectSetting(
		deps,
		"Widget separator — between widgets only (· or │; inner pairs stay ·)",
		["dot", "bar"] satisfies readonly StatuslineSeparator[],
		current,
		DEFAULT_CONFIG.separator,
	);
	if (!separator) return;
	if (separator === current) {
		deps.ui.notify(`separator already ${separator}`, "info");
		return;
	}
	applyOrNotify(deps, { ...config, separator }, `separator: ${separatorLabel(separator)}`);
}

async function setContextMode(deps: ConfigureDeps): Promise<void> {
	const config = deps.getConfig();
	const contextMode = await selectSetting(
		deps,
		"Context mode (context / contextBar percent)",
		["remaining", "used"] satisfies readonly ContextMode[],
		config.contextMode,
		DEFAULT_CONFIG.contextMode,
	);
	if (!contextMode) return;
	if (contextMode === config.contextMode) {
		deps.ui.notify(`contextMode already ${contextMode}`, "info");
		return;
	}

	applyOrNotify(deps, { ...config, contextMode }, `contextMode: ${contextMode}`);
}

async function setContextBarWidth(deps: ConfigureDeps): Promise<void> {
	const config = deps.getConfig();
	const raw = await deps.ui.input(
		`Context bar width — only when contextBar enabled (default ${DEFAULT_CONTEXT_BAR_WIDTH}, min ${MIN_CONTEXT_BAR_WIDTH}, max ${MAX_CONTEXT_BAR_WIDTH})`,
		String(config.contextBarWidth),
	);
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
	const current = isMinimalProfile(config) ? "on" : "off";
	const defaultValue = DEFAULT_CONFIG.minimal ? "on" : "off";
	const choice = await selectSetting(
		deps,
		[
			"Minimal profile",
			"pi-core widgets + mode/fast/state",
			`on  = ${MINIMAL_PROFILE.widgets.join(", ")}`,
			"     + single/plain · abbr labels (ctx/CH, keep in/out/$)",
			"off = clear abbr labels only (widgets unchanged)",
		].join("\n"),
		["on", "off"],
		current,
		defaultValue,
	);
	if (!choice) return;

	if (choice === "on") {
		if (isMinimalProfile(config)) {
			deps.ui.notify("minimal profile already applied", "info");
			return;
		}
		const profile = cloneMinimalProfile();
		applyOrNotify(
			deps,
			profile,
			`minimal profile: ${profile.widgets.join(", ")} · single/plain · abbr labels`,
		);
		return;
	}

	if (!config.minimal) {
		deps.ui.notify("minimal already off", "info");
		return;
	}
	applyOrNotify(deps, { ...config, minimal: false }, "minimal: false (widgets unchanged)");
}

async function setToolActivityMode(deps: ConfigureDeps): Promise<void> {
	const config = deps.getConfig();
	const choice = await selectSetting(
		deps,
		"Tool activity mode — only when toolActivity enabled",
		["detailed", "compact"],
		config.toolActivityMode,
		DEFAULT_CONFIG.toolActivityMode,
	);
	if (!choice) return;
	const toolActivityMode = choice as ToolActivityMode;
	if (toolActivityMode === config.toolActivityMode) {
		deps.ui.notify(`toolActivityMode already ${toolActivityMode}`, "info");
		return;
	}
	applyOrNotify(deps, { ...config, toolActivityMode }, `toolActivityMode: ${toolActivityMode}`);
}

async function setWidgetSpacing(deps: ConfigureDeps): Promise<void> {
	const config = deps.getConfig();
	const raw = await deps.ui.input(
		`Widget spacing — spaces on each side of separator (default ${DEFAULT_WIDGET_SPACING}, min ${MIN_WIDGET_SPACING}, max ${MAX_WIDGET_SPACING})`,
		String(config.spacing),
	);
	if (raw === undefined) return;

	const parsed = parseWidgetSpacing(raw);
	if (!parsed.ok) {
		deps.ui.notify(parsed.error, "error");
		return;
	}

	applyOrNotify(deps, { ...config, spacing: parsed.value }, `spacing: ${parsed.value}`);
}

async function runAppearanceMenu(deps: ConfigureDeps): Promise<void> {
	while (true) {
		const choice = await deps.ui.select(
			[
				"Appearance",
				"layout · icons · separator · spacing · minimal profile",
			].join("\n"),
			[
				"Layout",
				"Icon mode",
				"Widget separator",
				"Widget spacing",
				"Minimal profile",
				"Back",
			],
		);
		if (!choice || choice === "Back") return;
		switch (choice) {
			case "Layout":
				await setLayout(deps);
				break;
			case "Icon mode":
				await setIconMode(deps);
				break;
			case "Widget separator":
				await setWidgetSeparator(deps);
				break;
			case "Widget spacing":
				await setWidgetSpacing(deps);
				break;
			case "Minimal profile":
				await setMinimalMode(deps);
				break;
			default:
				break;
		}
	}
}

export function contextUsageItems(config: StatuslineConfig): string[] {
	const items: string[] = [];
	if (config.widgets.includes("context") || config.widgets.includes("contextBar")) items.push("Context mode");
	if (config.widgets.includes("contextBar")) items.push("Context bar width");
	if (config.widgets.includes("toolActivity")) items.push("Tool activity mode");
	return items;
}

async function runContextUsageMenu(deps: ConfigureDeps): Promise<void> {
	while (true) {
		const items = contextUsageItems(deps.getConfig());
		if (items.length === 0) {
			deps.ui.notify("Enable context, contextBar, or toolActivity before configuring their display settings.", "info");
			return;
		}
		const choice = await deps.ui.select(
			[
				"Context & usage",
				"only settings for enabled widgets are shown",
			].join("\n"),
			[...items, "Back"],
		);
		if (!choice || choice === "Back") return;
		switch (choice) {
			case "Context mode":
				await setContextMode(deps);
				break;
			case "Context bar width":
				await setContextBarWidth(deps);
				break;
			case "Tool activity mode":
				await setToolActivityMode(deps);
				break;
			default:
				break;
		}
	}
}

async function runTelemetryMenu(deps: ConfigureDeps): Promise<void> {
	while (true) {
		const config = deps.getConfig();
		const telemetry = config.telemetry ?? DEFAULT_CONFIG.telemetry!;
		const items = [
			`Display: ${telemetry.display}`,
			...(["tps", "ttft", "duration", "tokens", "stalls", "cost"] as const)
				.map((key) => `${key}: ${telemetry[key] ? "on" : "off"}`),
			"Back",
		];
		const choice = await deps.ui.select("Telemetry — one renderer per settled run", items);
		if (!choice || choice === "Back") return;
		if (choice.startsWith("Display:")) {
			const display = await selectSetting(
				deps,
				"Telemetry display",
				["off", "widget", "notification"],
				telemetry.display,
				DEFAULT_CONFIG.telemetry!.display,
			);
			if (!display) continue;
			let widgets: WidgetId[] = config.widgets.filter((id) => id !== "performance");
			if (display === "widget") widgets = [...widgets, "performance"];
			applyOrNotify(deps, { ...config, widgets, telemetry: { ...telemetry, display } }, `telemetry: ${display}`);
			continue;
		}
		const key = (["tps", "ttft", "duration", "tokens", "stalls", "cost"] as const)
			.find((name) => choice.startsWith(`${name}:`));
		if (key) applyOrNotify(deps, { ...config, telemetry: { ...telemetry, [key]: !telemetry[key] } }, `${key}: ${!telemetry[key]}`);
	}
}

export async function runStatuslineConfigurator(
	deps: ConfigureDeps,
	allWidgets: readonly WidgetId[],
): Promise<void> {
	while (true) {
		const config = deps.getConfig();
		const configPath = deps.getConfigPath();
		const choice = await deps.ui.selectMain(mainMenuTitle(config, configPath), [
			"Widgets",
			"Appearance",
			"Telemetry",
			...(contextUsageItems(config).length > 0 ? ["Context & usage"] : []),
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
			case "Appearance":
				await runAppearanceMenu(deps);
				break;
			case "Telemetry":
				await runTelemetryMenu(deps);
				break;
			case "Context & usage":
				await runContextUsageMenu(deps);
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
				const confirmed = await deps.ui.confirm(
					"Reset statusline config?",
					`Overwrite ${configPath} with package defaults?`,
				);
				if (!confirmed) break;
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
