import {
	cloneMinimalProfile,
	cloneWidgetLines,
	DEFAULT_CONFIG,
	DEFAULT_CONTEXT_BAR_WIDTH,
	DEFAULT_WIDGET_SPACING,
	emptyWidgetLines,
	enabledWidgets,
	hasWidget,
	isMinimalProfile,
	MAX_CONTEXT_BAR_WIDTH,
	MAX_WIDGET_SPACING,
	MIN_CONTEXT_BAR_WIDTH,
	MIN_WIDGET_SPACING,
	MINIMAL_WIDGETS,
	WIDGET_SEPARATOR_GLYPHS,
} from "./config.ts";
import type {
	ContextMode,
	IconMode,
	StatuslineConfig,
	StatuslineSeparator,
	ToolActivityMode,
	WidgetId,
	WidgetLineId,
	WidgetLines,
} from "./types.ts";
import { WIDGET_LINE_IDS } from "./types.ts";

export type MutationResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };

export type WidgetEditorItem = {
	id: WidgetId;
	enabled: boolean;
	line: WidgetLineId;
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
	selectMain(title: string, items: string[]): Promise<string | undefined>;
	select(title: string, items: string[]): Promise<string | undefined>;
	input(title: string, initialValue: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	/** Space toggle, g cycle line, Up/Down select, Left/Right move. */
	editWidgets(
		title: string,
		allWidgets: readonly WidgetId[],
		lines: WidgetLines,
		onChange: (lines: WidgetLines) => boolean,
		onReject?: (error: string) => void,
	): Promise<WidgetLines | undefined>;
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

/** Swap item at index with neighbor. Returns undefined if out of bounds. */
export function swapAdjacent<T>(
	items: readonly T[],
	index: number,
	delta: -1 | 1,
): { items: T[]; index: number } | undefined {
	const target = index + delta;
	if (index < 0 || index >= items.length || target < 0 || target >= items.length) return undefined;
	const next = [...items];
	const current = next[index]!;
	next[index] = next[target]!;
	next[target] = current;
	return { items: next, index: target };
}

export function flattenWidgetLines(lines: WidgetLines): WidgetId[] {
	return WIDGET_LINE_IDS.flatMap((line) => lines[line]);
}

/** Add disabled catalog entries to transient LINE1 while preserving configured line order. */
export function initialEditorLines(lines: WidgetLines, allWidgets: readonly WidgetId[]): WidgetLines {
	const all = new Set<WidgetId>(allWidgets);
	const seen = new Set<WidgetId>();
	const editorLines = emptyWidgetLines();
	for (const line of WIDGET_LINE_IDS) {
		for (const id of lines[line]) {
			if (!all.has(id) || seen.has(id)) continue;
			seen.add(id);
			editorLines[line].push(id);
		}
	}
	for (const id of allWidgets) {
		if (seen.has(id)) continue;
		seen.add(id);
		editorLines.line1.push(id);
	}
	return editorLines;
}

export function enabledLines(editorLines: WidgetLines, enabled: ReadonlySet<WidgetId>): WidgetLines {
	const lines = emptyWidgetLines();
	for (const line of WIDGET_LINE_IDS) lines[line] = editorLines[line].filter((id) => enabled.has(id));
	return lines;
}

export function buildWidgetEditorItems(
	lines: WidgetLines,
	enabled: ReadonlySet<WidgetId>,
): WidgetEditorItem[] {
	return WIDGET_LINE_IDS.flatMap((line) => lines[line].map((id) => ({ id, line, enabled: enabled.has(id) })));
}

export function toggleEditorItem(
	items: readonly WidgetEditorItem[],
	index: number,
): MutationResult<WidgetEditorItem[]> {
	const current = items[index];
	if (!current) return { ok: false, error: "Invalid selection" };
	if (current.enabled && items.filter((item) => item.enabled).length <= 1) {
		return { ok: false, error: "At least one widget must remain enabled" };
	}
	return {
		ok: true,
		value: items.map((item, itemIndex) => itemIndex === index ? { ...item, enabled: !item.enabled } : item),
	};
}

/** Move within a line, or cross its edge into the immediately adjacent line. */
export function moveWidgetInLines(
	lines: WidgetLines,
	id: WidgetId,
	delta: -1 | 1,
): WidgetLines | undefined {
	const sourceLine = WIDGET_LINE_IDS.find((line) => lines[line].includes(id));
	if (!sourceLine) return undefined;
	const sourceIndex = lines[sourceLine].indexOf(id);
	const targetIndex = sourceIndex + delta;
	const next = cloneWidgetLines(lines);
	if (targetIndex >= 0 && targetIndex < lines[sourceLine].length) {
		const swapped = swapAdjacent(next[sourceLine], sourceIndex, delta);
		if (!swapped) return undefined;
		next[sourceLine] = swapped.items;
		return next;
	}
	const destinationLine = WIDGET_LINE_IDS[WIDGET_LINE_IDS.indexOf(sourceLine) + delta];
	if (!destinationLine) return undefined;
	next[sourceLine] = next[sourceLine].filter((widget) => widget !== id);
	if (delta > 0) next[destinationLine].unshift(id);
	else next[destinationLine].push(id);
	return next;
}

export function cycleWidgetLine(lines: WidgetLines, id: WidgetId): WidgetLines | undefined {
	const current = WIDGET_LINE_IDS.find((line) => lines[line].includes(id));
	if (!current) return undefined;
	const nextLine = WIDGET_LINE_IDS[(WIDGET_LINE_IDS.indexOf(current) + 1) % WIDGET_LINE_IDS.length]!;
	const next = cloneWidgetLines(lines);
	next[current] = next[current].filter((widget) => widget !== id);
	next[nextLine].push(id);
	return next;
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

function lineSummary(config: StatuslineConfig): string[] {
	return WIDGET_LINE_IDS.map((line) => `${line.toUpperCase()}: ${config.lines[line].join(", ") || "(empty)"}`);
}

export function formatConfigSummary(config: StatuslineConfig, configPath: string): string {
	return [
		...lineSummary(config),
		`iconMode: ${config.iconMode}`,
		`contextMode: ${config.contextMode}`,
		`contextBarWidth: ${config.contextBarWidth} (default ${DEFAULT_CONTEXT_BAR_WIDTH}, min ${MIN_CONTEXT_BAR_WIDTH}, max ${MAX_CONTEXT_BAR_WIDTH})`,
		`minimal: ${config.minimal}${isMinimalProfile(config) ? " (profile)" : config.minimal ? " (abbr labels)" : ""}`,
		`runNotification: ${config.runNotification ? "on" : "off"}`,
		`toolActivityMode: ${config.toolActivityMode}`,
		`separator: ${separatorLabel(config.separator)}`,
		`spacing: ${config.spacing} (default ${DEFAULT_WIDGET_SPACING}, min ${MIN_WIDGET_SPACING}, max ${MAX_WIDGET_SPACING})`,
		`config: ${configPath}`,
	].join("\n");
}

function mainMenuTitle(config: StatuslineConfig, configPath: string): string {
	const minimalLabel = isMinimalProfile(config) ? "profile" : config.minimal ? "abbr labels" : "off";
	return [
		"Statusline Config",
		...lineSummary(config),
		`iconMode: ${config.iconMode} · separator: ${separatorLabel(config.separator)} · spacing: ${config.spacing}`,
		`contextMode: ${config.contextMode} · bar: ${config.contextBarWidth} · toolActivityMode: ${config.toolActivityMode}`,
		`minimal: ${minimalLabel} · runNotification: ${config.runNotification ? "on" : "off"}`,
		`config: ${configPath}`,
	].join("\n");
}

function applyOrNotify(deps: ConfigureDeps, next: StatuslineConfig, success: string): boolean {
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
		"Widgets by LINE",
		allWidgets,
		cloneWidgetLines(config.lines),
		(lines) => applyOrNotify(deps, { ...deps.getConfig(), lines: cloneWidgetLines(lines) }, "widget lines updated"),
		(error) => deps.ui.notify(error, "warning"),
	);
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
	const choice = await selectSetting(
		deps,
		[
			"Minimal profile",
			`on  = ${MINIMAL_WIDGETS.join(", ")}`,
			"     + explicit LINE0/LINE1 · plain icons · abbreviated labels",
			"off = clear abbreviated labels only (lines unchanged)",
		].join("\n"),
		["on", "off"],
		current,
		DEFAULT_CONFIG.minimal ? "on" : "off",
	);
	if (!choice) return;
	if (choice === "on") {
		if (isMinimalProfile(config)) {
			deps.ui.notify("minimal profile already applied", "info");
			return;
		}
		const profile = { ...cloneMinimalProfile(), runNotification: config.runNotification };
		applyOrNotify(deps, profile, "minimal profile applied");
		return;
	}
	if (!config.minimal) {
		deps.ui.notify("minimal already off", "info");
		return;
	}
	applyOrNotify(deps, { ...config, minimal: false }, "minimal: false (lines unchanged)");
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
			["Appearance", "icons · separator · spacing · minimal profile"].join("\n"),
			["Icon mode", "Widget separator", "Widget spacing", "Minimal profile", "Back"],
		);
		if (!choice || choice === "Back") return;
		switch (choice) {
			case "Icon mode": await setIconMode(deps); break;
			case "Widget separator": await setWidgetSeparator(deps); break;
			case "Widget spacing": await setWidgetSpacing(deps); break;
			case "Minimal profile": await setMinimalMode(deps); break;
		}
	}
}

export function contextUsageItems(config: StatuslineConfig): string[] {
	const items: string[] = [];
	if (hasWidget(config, "context") || hasWidget(config, "contextBar")) items.push("Context mode");
	if (hasWidget(config, "contextBar")) items.push("Context bar width");
	if (hasWidget(config, "toolActivity")) items.push("Tool activity mode");
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
			["Context & usage", "only settings for enabled widgets are shown"].join("\n"),
			[...items, "Back"],
		);
		if (!choice || choice === "Back") return;
		switch (choice) {
			case "Context mode": await setContextMode(deps); break;
			case "Context bar width": await setContextBarWidth(deps); break;
			case "Tool activity mode": await setToolActivityMode(deps); break;
		}
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
			`Run notification: ${config.runNotification ? "on" : "off"}`,
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
			case "Run notification: off":
			case "Run notification: on": {
				const enabled = !Boolean(config.runNotification);
				applyOrNotify(deps, { ...config, runNotification: enabled }, `runNotification: ${enabled ? "on" : "off"}`);
				break;
			}
			case "Context & usage":
				await runContextUsageMenu(deps);
				break;
			case "Show config":
				deps.ui.notify(formatConfigSummary(config, configPath), "info");
				break;
			case "Reload from file": {
				const reloaded = deps.reloadConfig();
				if (!reloaded.ok) deps.ui.notify(reloaded.error, "error");
				else deps.ui.notify(`Reloaded (${enabledWidgets(reloaded.value).join(", ")})`, "info");
				break;
			}
			case "Reset to defaults": {
				const confirmed = await deps.ui.confirm(
					"Reset statusline config?",
					`Overwrite ${configPath} with package defaults?`,
				);
				if (!confirmed) break;
				const reset = deps.resetConfig();
				if (!reset.ok) deps.ui.notify(reset.error, "error");
				else deps.ui.notify("Reset to defaults", "info");
				break;
			}
		}
	}
}
