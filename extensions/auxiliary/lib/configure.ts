import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, Text, fuzzyFilter } from "@earendil-works/pi-tui";

import {
	mergeAuxiliaryConfig,
	parseModelRef,
	readAuxiliaryConfigSource,
	resolveAuxiliaryConfigPath,
	resolveTaskRoute,
	updateAuxiliaryConfig,
} from "./config.ts";
import { selectMenu, type SelectMenuOption } from "./select-menu.ts";
import type { AuxiliaryConfig, AuxiliaryRouteConfig, AuxiliaryTaskKey } from "./types.ts";

export const CONFIGURABLE_AUXILIARY_TASKS = [
	"compression",
	"title_generation",
	"text_summary",
	"commit_message",
	"btw",
	"web_research",
] as const satisfies readonly AuxiliaryTaskKey[];

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

const NUMBER_FIELDS = {
	timeoutMs: { label: "Timeout", minimum: 1_000, maximum: 600_000, suffix: "ms" },
	maxOutputTokens: { label: "Max output tokens", minimum: 16, maximum: 128_000, suffix: "" },
	maxRetries: { label: "Retries", minimum: 0, maximum: 2, suffix: "" },
} as const;

const ROUTE_OVERRIDE_FIELDS = ["model", "thinking", "timeoutMs", "maxOutputTokens", "maxRetries", "fallbackModels"] as const;

type ConfigurableTask = typeof CONFIGURABLE_AUXILIARY_TASKS[number];
type NumberField = keyof typeof NUMBER_FIELDS;
type RouteField = keyof AuxiliaryRouteConfig;
type RouteTarget = { kind: "default" } | { kind: "task"; task: ConfigurableTask };

type MutationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const TASK_ROUTE_FIELDS: Record<ConfigurableTask, ReadonlySet<RouteField>> = {
	compression: new Set(ROUTE_OVERRIDE_FIELDS.filter((field) => field !== "maxRetries")),
	title_generation: new Set(ROUTE_OVERRIDE_FIELDS),
	text_summary: new Set(ROUTE_OVERRIDE_FIELDS),
	commit_message: new Set(ROUTE_OVERRIDE_FIELDS),
	btw: new Set(ROUTE_OVERRIDE_FIELDS.filter((field) => field !== "maxRetries")),
	web_research: new Set(ROUTE_OVERRIDE_FIELDS.filter(
		(field) => field !== "maxRetries" && field !== "maxOutputTokens",
	)),
};

function routeFieldVisible(target: RouteTarget, field: RouteField): boolean {
	return target.kind === "default" || TASK_ROUTE_FIELDS[target.task].has(field);
}

export interface AuxiliaryConfiguratorUi {
	select(title: string, options: readonly SelectMenuOption[]): Promise<string | undefined>;
	input(title: string, placeholder: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	pickModel(title: string, current: string, modelRefs: readonly string[]): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
}

export interface AuxiliaryConfiguratorDeps {
	agentDir: string;
	currentModel?: string;
	modelRefs: readonly string[];
	ui: AuxiliaryConfiguratorUi;
}

interface ConfiguratorState {
	source: Record<string, unknown>;
	config: AuxiliaryConfig;
	warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compact(value: string, maximum = 52): string {
	if (value.length <= maximum) return value;
	const left = Math.floor((maximum - 3) / 2);
	return `${value.slice(0, left)}...${value.slice(value.length - (maximum - 3 - left))}`;
}

function menuItem(value: string, description: string): SelectMenuOption {
	return { value, description };
}

function loadState(agentDir: string): MutationResult<ConfiguratorState> {
	const source = readAuxiliaryConfigSource(agentDir);
	if (!source.ok) return source;
	const merged = mergeAuxiliaryConfig({ auxiliary: source.value });
	return {
		ok: true,
		value: { source: source.value, config: merged.config, warnings: merged.warnings },
	};
}

function configuredTaskRoute(config: AuxiliaryConfig, task: ConfigurableTask): AuxiliaryRouteConfig {
	const taskConfig = config.tasks[task] ?? {};
	return resolveTaskRoute({
		...config,
		tasks: {
			...config.tasks,
			[task]: { ...taskConfig, useAuxiliary: true },
		},
	}, task);
}

function targetRoute(config: AuxiliaryConfig, target: RouteTarget): AuxiliaryRouteConfig {
	return target.kind === "default" ? config.default : configuredTaskRoute(config, target.task);
}

function rawRoute(source: Record<string, unknown>, target: RouteTarget): Record<string, unknown> {
	if (target.kind === "default") return isRecord(source.default) ? source.default : {};
	if (!isRecord(source.tasks)) return {};
	const route = source.tasks[target.task];
	return isRecord(route) ? route : {};
}

function targetName(target: RouteTarget): string {
	return target.kind === "default" ? "Default route" : target.task;
}

function hasRouteOverride(route: Record<string, unknown>, target: RouteTarget): boolean {
	return ROUTE_OVERRIDE_FIELDS.some((field) => Object.hasOwn(route, field))
		|| (target.kind === "task" && Object.hasOwn(route, "useAuxiliary"));
}

function selected<T extends string>(choice: string | undefined, values: readonly T[]): T | undefined {
	if (!choice) return undefined;
	return values.find((value) => choice === value || choice.startsWith(`${value} `));
}

export function availableTextModelRefs(
	models: readonly { provider: string; id: string; input: readonly string[] }[],
): string[] {
	return [...new Set(models
		.filter((model) => model.input.includes("text"))
		.map((model) => `${model.provider}/${model.id}`))]
		.sort((left, right) => left.localeCompare(right));
}

export function resolveCurrentModelRef(ref: string, currentModel?: string): string {
	return ref === "current" && currentModel ? currentModel : ref;
}

export function redactConfigForDisplay(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactConfigForDisplay);
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [
		key,
		key === "apiKey" || key === "baseUrl" || key === "headers" ? "[redacted]" : redactConfigForDisplay(item),
	]));
}

export function parseRouteInteger(
	raw: string,
	label: string,
	minimum: number,
	maximum: number,
): MutationResult<number> {
	const error = `${label} must be an integer from ${minimum} to ${maximum}`;
	if (!/^\d+$/.test(raw.trim())) return { ok: false, error };
	const value = Number.parseInt(raw.trim(), 10);
	return value >= minimum && value <= maximum ? { ok: true, value } : { ok: false, error };
}

function editRouteObject(
	auxiliary: Record<string, unknown>,
	target: RouteTarget,
	mutate: (route: Record<string, unknown>) => void,
): void {
	if (target.kind === "default") {
		if (Object.hasOwn(auxiliary, "default") && !isRecord(auxiliary.default)) {
			throw new Error("auxiliary.default must be a JSON object");
		}
		const route = isRecord(auxiliary.default) ? auxiliary.default : {};
		mutate(route);
		if (Object.keys(route).length === 0) delete auxiliary.default;
		else auxiliary.default = route;
		return;
	}

	if (Object.hasOwn(auxiliary, "tasks") && !isRecord(auxiliary.tasks)) {
		throw new Error("auxiliary.tasks must be a JSON object");
	}
	const tasks = isRecord(auxiliary.tasks) ? auxiliary.tasks : {};
	const existingRoute = tasks[target.task];
	if (Object.hasOwn(tasks, target.task) && !isRecord(existingRoute)) {
		throw new Error(`auxiliary.tasks.${target.task} must be a JSON object`);
	}
	const route = isRecord(existingRoute) ? existingRoute : {};
	mutate(route);
	if (Object.keys(route).length === 0) delete tasks[target.task];
	else tasks[target.task] = route;
	if (Object.keys(tasks).length === 0) delete auxiliary.tasks;
	else auxiliary.tasks = tasks;
}

function applyMutation(
	deps: AuxiliaryConfiguratorDeps,
	mutate: (auxiliary: Record<string, unknown>) => void,
	success: string,
): boolean {
	const result = updateAuxiliaryConfig(deps.agentDir, mutate);
	if (!result.ok) {
		deps.ui.notify(result.error, "error");
		return false;
	}
	deps.ui.notify(success, "info");
	return true;
}

function setRouteField(
	deps: AuxiliaryConfiguratorDeps,
	target: RouteTarget,
	field: RouteField | "useAuxiliary",
	value: unknown,
	success: string,
): boolean {
	return applyMutation(deps, (auxiliary) => editRouteObject(auxiliary, target, (route) => {
		if (value === undefined) delete route[field];
		else route[field] = value;
	}), success);
}

function rawGitPolicy(source: Record<string, unknown>): Record<string, unknown> {
	return isRecord(source.git) ? source.git : {};
}

function editGitPolicyObject(
	auxiliary: Record<string, unknown>,
	mutate: (policy: Record<string, unknown>) => void,
): void {
	if (Object.hasOwn(auxiliary, "git") && !isRecord(auxiliary.git)) {
		throw new Error("auxiliary.git must be a JSON object");
	}
	const policy = isRecord(auxiliary.git) ? auxiliary.git : {};
	mutate(policy);
	if (Object.keys(policy).length === 0) delete auxiliary.git;
	else auxiliary.git = policy;
}

function setGitPolicyField(
	deps: AuxiliaryConfiguratorDeps,
	field: "confirm" | "allowHeadless" | "allowPush",
	value: boolean | undefined,
	success: string,
): boolean {
	return applyMutation(deps, (auxiliary) => editGitPolicyObject(auxiliary, (policy) => {
		if (value === undefined) delete policy[field];
		else policy[field] = value;
	}), success);
}

async function editGitPolicy(deps: AuxiliaryConfiguratorDeps): Promise<void> {
	while (true) {
		const loaded = loadState(deps.agentDir);
		if (!loaded.ok) {
			deps.ui.notify(loaded.error, "error");
			return;
		}
		const state = loaded.value;
		const raw = rawGitPolicy(state.source);
		const config = state.config.git;
		const choice = await deps.ui.select("Git finalize policy", [
			menuItem(
				`Confirm before commit: ${config.confirm ? "on" : "off"}`,
				"Shows the exact branch, commit subject, and push action for confirmation before an interactive commit.",
			),
			menuItem(
				`Allow headless: ${config.allowHeadless ? "on" : "off"}`,
				"Allows git_finalize to commit without interactive confirmation when no TUI is available.",
			),
			menuItem(
				`Allow push: ${config.allowPush ? "on" : "off"}`,
				"Permits a normal push only when explicitly requested and an existing upstream is configured.",
			),
			...(( ["confirm", "allowHeadless", "allowPush"] as const).some((field) => Object.hasOwn(raw, field))
				? [menuItem("Reset Git policy", "Restores package Git policy defaults while preserving unknown policy fields.")]
				: []),
			"Back",
		]);
		if (!choice || choice === "Back") return;
		if (choice === "Reset Git policy") {
			const confirmed = await deps.ui.confirm(
				"Reset Git finalize policy?",
				"Restore Git finalization defaults while keeping unknown policy fields?",
			);
			if (confirmed) {
				applyMutation(deps, (auxiliary) => editGitPolicyObject(auxiliary, (policy) => {
					delete policy.confirm;
					delete policy.allowHeadless;
					delete policy.allowPush;
				}), "Git finalize policy reset");
			}
			continue;
		}
		const field = choice.startsWith("Confirm before commit")
			? "confirm"
			: choice.startsWith("Allow headless")
				? "allowHeadless"
				: "allowPush";
		const current = config[field];
		const next = await deps.ui.select(choice, [
			current ? "On [current]" : "On",
			current ? "Off" : "Off [current]",
			"Back",
		]);
		if (!next || next === "Back") continue;
		const value = next.startsWith("On");
		if (value !== current) {
			setGitPolicyField(deps, field, value, `Git ${field}: ${value ? "on" : "off"}`);
		}
	}
}

function mainMenuTitle(deps: AuxiliaryConfiguratorDeps, state: ConfiguratorState): string {
	return [
		"Auxiliary Models",
		`runtime: ${state.config.enabled ? "enabled" : "disabled"} · main: ${deps.currentModel ?? "none"}`,
		`default: ${compact(state.config.default.model)} · thinking ${state.config.default.thinking}`,
		`config: ${resolveAuxiliaryConfigPath(deps.agentDir)}`,
	].join("\n");
}

function mainMenuItems(state: ConfiguratorState): Array<{ id: string; label: string; description?: string }> {
	const items: Array<{ id: string; label: string; description?: string }> = [
		{
			id: "runtime",
			label: `Runtime: ${state.config.enabled ? "enabled" : "disabled"}`,
			description: "Disabling stops auxiliary hooks and tools without deleting saved routes.",
		},
		{
			id: "default",
			label: `Default route: ${compact(state.config.default.model)} · ${state.config.default.thinking}`,
			description: "Fallback values for route fields without a task-specific preset or override; task-specific values still win.",
		},
	];
	for (const task of CONFIGURABLE_AUXILIARY_TASKS) {
		const enabled = state.config.tasks[task]?.useAuxiliary !== false;
		const route = configuredTaskRoute(state.config, task);
		items.push({
			id: `task:${task}`,
			label: `${task}: ${enabled ? "aux" : "main"} · ${compact(enabled ? route.model : "current")}`,
			description: enabled
				? "Uses its saved auxiliary route; task-specific limits and fallbacks can override the default route."
				: "Uses the current main model while keeping its saved auxiliary route for later.",
		});
	}
	items.push(
		{
			id: "git",
			label: `Git finalize policy: confirm ${state.config.git.confirm ? "on" : "off"} · headless ${state.config.git.allowHeadless ? "on" : "off"} · push ${state.config.git.allowPush ? "on" : "off"}`,
			description: "Controls interactive confirmation, headless commits, and permission for normal pushes.",
		},
		{ id: "vision", label: "Vision: external · /vision-handoff", description: "Vision routing is configured separately by /vision-handoff." },
		{ id: "show", label: "Show config", description: "Displays the stored auxiliary section with credential-bearing fields redacted." },
		{ id: "done", label: "Done" },
	);
	return items;
}

async function editRuntime(deps: AuxiliaryConfiguratorDeps, config: AuxiliaryConfig): Promise<void> {
	const enabledLabel = config.enabled ? "Enabled [current]" : "Enabled";
	const disabledLabel = config.enabled ? "Disabled" : "Disabled [current]";
	const choice = await deps.ui.select("Auxiliary runtime", [enabledLabel, disabledLabel, "Back"]);
	if (!choice || choice === "Back") return;
	const enabled = choice.startsWith("Enabled");
	if (enabled === config.enabled) return;
	applyMutation(deps, (auxiliary) => {
		auxiliary.enabled = enabled;
	}, `auxiliary runtime: ${enabled ? "enabled" : "disabled"}`);
}

async function editUseAuxiliary(
	deps: AuxiliaryConfiguratorDeps,
	state: ConfiguratorState,
	task: ConfigurableTask,
): Promise<void> {
	const enabled = state.config.tasks[task]?.useAuxiliary !== false;
	const choice = await deps.ui.select("Use auxiliary model", [
		enabled ? "On [current]" : "On",
		enabled ? "Off" : "Off [current]",
		"Back",
	]);
	if (!choice || choice === "Back") return;
	const next = choice.startsWith("On");
	if (next === enabled) return;
	setRouteField(
		deps,
		{ kind: "task", task },
		"useAuxiliary",
		next ? undefined : false,
		`${task}: ${next ? "auxiliary model enabled" : "using current main model"}`,
	);
}

async function editPrimaryModel(
	deps: AuxiliaryConfiguratorDeps,
	state: ConfiguratorState,
	target: RouteTarget,
): Promise<void> {
	const route = targetRoute(state.config, target);
	const raw = rawRoute(state.source, target);
	const choice = await deps.ui.select(`${targetName(target)} primary model`, [
		...(Object.hasOwn(raw, "model") ? ["Reset override"] : []),
		`Current main model (${deps.currentModel ?? "none"})`,
		"Choose model...",
		"Back",
	]);
	if (!choice || choice === "Back") return;
	if (choice.startsWith("Reset override")) {
		setRouteField(deps, target, "model", undefined, `${targetName(target)} model override reset`);
		return;
	}
	if (choice.startsWith("Current main model")) {
		setRouteField(deps, target, "model", "current", `${targetName(target)} model: current`);
		return;
	}
	const model = await deps.ui.pickModel(`${targetName(target)} model`, route.model, deps.modelRefs);
	if (!model) return;
	if (!deps.modelRefs.includes(model) || parseModelRef(model) === undefined) {
		deps.ui.notify(`Unavailable model: ${model}`, "error");
		return;
	}
	setRouteField(deps, target, "model", model, `${targetName(target)} model: ${model}`);
}

async function editThinking(
	deps: AuxiliaryConfiguratorDeps,
	state: ConfiguratorState,
	target: RouteTarget,
): Promise<void> {
	const route = targetRoute(state.config, target);
	const raw = rawRoute(state.source, target);
	const options = [
		...(Object.hasOwn(raw, "thinking") ? ["Reset override"] : []),
		...THINKING_LEVELS.map((level) => `${level}${raw.thinking === level ? " [current]" : ""}`),
		"Back",
	];
	const choice = await deps.ui.select(`${targetName(target)} thinking`, options);
	if (!choice || choice === "Back") return;
	if (choice.startsWith("Reset override")) {
		setRouteField(deps, target, "thinking", undefined, `${targetName(target)} thinking override reset`);
		return;
	}
	const level = selected(choice, THINKING_LEVELS);
	if (level) setRouteField(deps, target, "thinking", level, `${targetName(target)} thinking: ${level}`);
}

async function editNumber(
	deps: AuxiliaryConfiguratorDeps,
	state: ConfiguratorState,
	target: RouteTarget,
	field: NumberField,
): Promise<void> {
	const spec = NUMBER_FIELDS[field];
	const current = targetRoute(state.config, target)[field];
	const route = rawRoute(state.source, target);
	const choice = await deps.ui.select(`${targetName(target)} ${spec.label}`, [
		`Set value (${current}${spec.suffix})`,
		...(Object.hasOwn(route, field) ? ["Reset override"] : []),
		"Back",
	]);
	if (!choice || choice === "Back") return;
	if (choice === "Reset override") {
		setRouteField(deps, target, field, undefined, `${targetName(target)} ${spec.label} override reset`);
		return;
	}
	const raw = await deps.ui.input(
		`${targetName(target)} ${spec.label} (${spec.minimum}-${spec.maximum}${spec.suffix ? ` ${spec.suffix}` : ""}; blank cancels)`,
		String(current),
	);
	if (raw === undefined || !raw.trim()) return;
	const parsed = parseRouteInteger(raw, spec.label, spec.minimum, spec.maximum);
	if (!parsed.ok) {
		deps.ui.notify(parsed.error, "error");
		return;
	}
	setRouteField(deps, target, field, parsed.value, `${targetName(target)} ${spec.label}: ${parsed.value}${spec.suffix}`);
}

async function editFallbackItem(
	deps: AuxiliaryConfiguratorDeps,
	target: RouteTarget,
	fallbacks: string[],
	index: number,
): Promise<void> {
	const options = [
		...(index > 0 ? ["Move up"] : []),
		...(index + 1 < fallbacks.length ? ["Move down"] : []),
		"Remove",
		"Back",
	];
	const choice = await deps.ui.select(`Fallback ${index + 1}: ${fallbacks[index]}`, options);
	if (!choice || choice === "Back") return;
	const next = [...fallbacks];
	if (choice === "Remove") next.splice(index, 1);
	else {
		const targetIndex = choice === "Move up" ? index - 1 : index + 1;
		[next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
	}
	setRouteField(deps, target, "fallbackModels", next, `${targetName(target)} fallbacks: ${next.join(", ") || "none"}`);
}

async function editFallbacks(deps: AuxiliaryConfiguratorDeps, target: RouteTarget): Promise<void> {
	while (true) {
		const loaded = loadState(deps.agentDir);
		if (!loaded.ok) {
			deps.ui.notify(loaded.error, "error");
			return;
		}
		const state = loaded.value;
		const route = targetRoute(state.config, target);
		const fallbacks = [...route.fallbackModels];
		const raw = rawRoute(state.source, target);
		const items = [
			...(fallbacks.length < 3 ? ["Add model..."] : []),
			...fallbacks.map((model, index) => `${index + 1}. ${compact(model)}`),
			...(fallbacks.length > 0 ? ["Clear all"] : []),
			...(Object.hasOwn(raw, "fallbackModels") ? ["Reset override"] : []),
			"Back",
		];
		const choice = await deps.ui.select(`${targetName(target)} fallback models (${fallbacks.length}/3)`, items);
		if (!choice || choice === "Back") return;
		if (choice === "Reset override") {
			setRouteField(deps, target, "fallbackModels", undefined, `${targetName(target)} fallback override reset`);
			continue;
		}
		if (choice === "Clear all") {
			setRouteField(deps, target, "fallbackModels", [], `${targetName(target)} fallbacks: none`);
			continue;
		}
		if (choice === "Add model...") {
			const model = await deps.ui.pickModel(`${targetName(target)} fallback`, "", deps.modelRefs);
			if (!model) continue;
			if (!deps.modelRefs.includes(model) || parseModelRef(model) === undefined) {
				deps.ui.notify(`Unavailable model: ${model}`, "error");
				continue;
			}
			const modelIdentity = resolveCurrentModelRef(model, deps.currentModel);
			const routeIdentity = resolveCurrentModelRef(route.model, deps.currentModel);
			const fallbackIdentities = fallbacks.map((fallback) => resolveCurrentModelRef(fallback, deps.currentModel));
			if (modelIdentity === routeIdentity || fallbackIdentities.includes(modelIdentity)) {
				deps.ui.notify(`Duplicate route model: ${model}`, "warning");
				continue;
			}
			setRouteField(deps, target, "fallbackModels", [...fallbacks, model], `${targetName(target)} fallback added: ${model}`);
			continue;
		}
		const index = Number.parseInt(choice, 10) - 1;
		if (Number.isInteger(index) && index >= 0 && index < fallbacks.length) {
			await editFallbackItem(deps, target, fallbacks, index);
		}
	}
}

async function applyDefaultModelToAllTasks(
	deps: AuxiliaryConfiguratorDeps,
	model: string,
): Promise<void> {
	const confirmed = await deps.ui.confirm(
		`Apply ${model} to all auxiliary tasks?`,
		`Set this primary model and enable auxiliary routing for ${CONFIGURABLE_AUXILIARY_TASKS.join(", ")}. Other task fields stay unchanged; vision is excluded.`,
	);
	if (!confirmed) return;
	applyMutation(deps, (auxiliary) => {
		for (const task of CONFIGURABLE_AUXILIARY_TASKS) {
			editRouteObject(auxiliary, { kind: "task", task }, (route) => {
				route.model = model;
				delete route.useAuxiliary;
			});
		}
	}, `Applied ${model} to all auxiliary tasks`);
}

function clearRouteOverrides(route: Record<string, unknown>, target: RouteTarget): void {
	for (const field of ROUTE_OVERRIDE_FIELDS) delete route[field];
	if (target.kind === "task") delete route.useAuxiliary;
}

function routePreview(target: RouteTarget, route: AuxiliaryRouteConfig): string {
	return [
		`model ${route.model}`,
		`thinking ${route.thinking}`,
		`timeout ${route.timeoutMs} ms`,
		...(routeFieldVisible(target, "maxOutputTokens") ? [`max output ${route.maxOutputTokens}`] : []),
		...(routeFieldVisible(target, "maxRetries") ? [`retries ${route.maxRetries}`] : []),
		`fallbacks ${route.fallbackModels.join(", ") || "none"}`,
	].join(", ");
}

function resetSnapshot(source: Record<string, unknown>, target: RouteTarget): { preview: string; signature: string } {
	const route = rawRoute(source, target);
	const fields = target.kind === "task" ? [...ROUTE_OVERRIDE_FIELDS, "useAuxiliary"] : ROUTE_OVERRIDE_FIELDS;
	const overrides = Object.fromEntries(fields.flatMap((field) =>
		Object.hasOwn(route, field) ? [[field, route[field]]] : []));
	const previewSource = structuredClone(source);
	editRouteObject(previewSource, target, (value) => clearRouteOverrides(value, target));
	const previewConfig = mergeAuxiliaryConfig({ auxiliary: previewSource }).config;
	const preview = routePreview(target, targetRoute(previewConfig, target));
	return { preview, signature: JSON.stringify([overrides, preview]) };
}

async function resetTarget(
	deps: AuxiliaryConfiguratorDeps,
	state: ConfiguratorState,
	target: RouteTarget,
): Promise<boolean> {
	const expected = resetSnapshot(state.source, target);
	const effect = target.kind === "default"
		? "Task overrides stay unchanged."
		: "Auxiliary routing returns to enabled; unknown task fields stay unchanged.";
	const confirmed = await deps.ui.confirm(
		`Reset ${targetName(target)}?`,
		`After reset: ${expected.preview}. ${effect}`,
	);
	if (!confirmed) return false;
	return applyMutation(deps, (auxiliary) => {
		if (resetSnapshot(auxiliary, target).signature !== expected.signature) {
			throw new Error("config changed while confirming reset; review the updated preview and try again");
		}
		editRouteObject(auxiliary, target, (route) => clearRouteOverrides(route, target));
	}, `${targetName(target)} overrides reset`);
}

async function routeMenu(deps: AuxiliaryConfiguratorDeps, target: RouteTarget): Promise<void> {
	while (true) {
		const loaded = loadState(deps.agentDir);
		if (!loaded.ok) {
			deps.ui.notify(loaded.error, "error");
			return;
		}
		const state = loaded.value;
		const route = targetRoute(state.config, target);
		const raw = rawRoute(state.source, target);
		const primaryLabel = `Primary model: ${Object.hasOwn(raw, "model") ? compact(String(raw.model)) : `inherited · ${compact(route.model)}`}`;
		const thinkingLabel = `Thinking: ${Object.hasOwn(raw, "thinking") ? String(raw.thinking) : `inherited · ${route.thinking}`}`;
		const timeoutLabel = `Timeout: ${route.timeoutMs} ms`;
		const outputLabel = `Max output tokens: ${route.maxOutputTokens}`;
		const retriesLabel = `Retries: ${route.maxRetries}`;
		const fallbackLabel = `Fallback models: ${route.fallbackModels.length ? route.fallbackModels.map((value) => compact(value, 30)).join(", ") : "none"}`;
		const resetLabel = `Reset ${target.kind === "default" ? "default route" : "task overrides"}`;
		const options: SelectMenuOption[] = [
			...(target.kind === "task" ? [menuItem(
				`Use auxiliary model: ${state.config.tasks[target.task]?.useAuxiliary === false ? "Off" : "On"}`,
				"On uses the saved auxiliary route. Off uses the current main model while retaining saved route settings.",
			)] : []),
			menuItem(
				primaryLabel,
				target.kind === "default"
					? "Primary fallback model for route fields without a task-specific model preset or override."
					: "First model attempted for this task; current follows the active main-session model.",
			),
			...(target.kind === "default" ? [menuItem(
				"Apply primary model to all tasks",
				`Copies ${route.model} to every task model and enables auxiliary routing for all six managed tasks. Other task fields stay unchanged; vision is excluded.`,
			)] : []),
			menuItem(thinkingLabel, "Requested reasoning level; models without reasoning support run with thinking off."),
			menuItem(timeoutLabel, "Maximum wall time for each model attempt before an eligible fallback is tried."),
			...(routeFieldVisible(target, "maxOutputTokens") ? [menuItem(
				outputLabel,
				"Maximum generated output tokens for this call, not an input or context-window limit. The model's own cap can be lower.",
			)] : []),
			...(routeFieldVisible(target, "maxRetries") ? [menuItem(
				retriesLabel,
				"Provider retries for each model attempt before moving to an eligible fallback; allowed range is 0-2.",
			)] : []),
			menuItem(fallbackLabel, "Models tried in order after eligible provider, availability, timeout, or empty-response failures."),
			...(hasRouteOverride(raw, target) ? [menuItem(
				resetLabel,
				target.kind === "default"
					? "Restores package defaults for this route; task overrides and unknown default fields stay unchanged."
					: "Removes known task overrides and returns to the package preset layered on the current default route.",
			)] : []),
			"Back",
		];
		const choice = await deps.ui.select(targetName(target), options);
		if (!choice || choice === "Back") return;
		if (choice.startsWith("Use auxiliary model") && target.kind === "task") {
			await editUseAuxiliary(deps, state, target.task);
		} else if (choice.startsWith("Primary model")) {
			await editPrimaryModel(deps, state, target);
		} else if (choice === "Apply primary model to all tasks" && target.kind === "default") {
			await applyDefaultModelToAllTasks(deps, route.model);
		} else if (choice.startsWith("Thinking")) {
			await editThinking(deps, state, target);
		} else if (choice.startsWith("Timeout")) {
			await editNumber(deps, state, target, "timeoutMs");
		} else if (choice.startsWith("Max output tokens")) {
			await editNumber(deps, state, target, "maxOutputTokens");
		} else if (choice.startsWith("Retries")) {
			await editNumber(deps, state, target, "maxRetries");
		} else if (choice.startsWith("Fallback models")) {
			await editFallbacks(deps, target);
		} else if (choice.startsWith("Reset") && await resetTarget(deps, state, target)) {
			return;
		}
	}
}

export async function runAuxiliaryConfigurator(deps: AuxiliaryConfiguratorDeps): Promise<void> {
	const warned = new Set<string>();
	while (true) {
		const loaded = loadState(deps.agentDir);
		if (!loaded.ok) {
			deps.ui.notify(loaded.error, "error");
			return;
		}
		const state = loaded.value;
		for (const warning of state.warnings) {
			if (warned.has(warning)) continue;
			warned.add(warning);
			deps.ui.notify(warning, "warning");
		}
		const items = mainMenuItems(state);
		const choice = await deps.ui.select(
			mainMenuTitle(deps, state),
			items.map((item) => item.description ? menuItem(item.label, item.description) : item.label),
		);
		const selectedItem = items.find((item) => item.label === choice);
		if (!selectedItem || selectedItem.id === "done") return;
		if (selectedItem.id === "runtime") {
			await editRuntime(deps, state.config);
		} else if (selectedItem.id === "default") {
			await routeMenu(deps, { kind: "default" });
		} else if (selectedItem.id.startsWith("task:")) {
			await routeMenu(deps, { kind: "task", task: selectedItem.id.slice(5) as ConfigurableTask });
		} else if (selectedItem.id === "git") {
			await editGitPolicy(deps);
		} else if (selectedItem.id === "vision") {
			deps.ui.notify("Vision routing is owned by pi-vision-handoff. Run /vision-handoff to configure it.", "info");
		} else if (selectedItem.id === "show") {
			deps.ui.notify(JSON.stringify({ auxiliary: redactConfigForDisplay(state.source) }, null, 2), "info");
		}
	}
}

export async function pickAvailableModel(
	ctx: ExtensionContext,
	title: string,
	current: string,
	modelRefs: readonly string[],
): Promise<string | undefined> {
	const parsed = modelRefs.flatMap((ref) => {
		const value = parseModelRef(ref);
		return value && value !== "current" ? [{ ref, provider: value.provider, modelId: value.modelId }] : [];
	});
	const providers = [...new Set(parsed.map((item) => item.provider))].sort();
	if (providers.length === 0) {
		ctx.ui.notify("No authenticated text models are available", "warning");
		return undefined;
	}
	const currentRef = resolveCurrentModelRef(current, ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
	const currentProvider = parseModelRef(currentRef);
	const providerItems = providers.map((provider) => {
		const count = parsed.filter((item) => item.provider === provider).length;
		const marker = currentProvider !== "current" && currentProvider?.provider === provider ? " [current]" : "";
		return `${provider} (${count})${marker}`;
	});
	const providerChoice = await selectMenu(ctx, `${title}: provider`, [...providerItems, "Back"]);
	if (!providerChoice || providerChoice === "Back") return undefined;
	const provider = providers.find((value) => providerChoice.startsWith(`${value} (`));
	if (!provider) return undefined;

	const models = parsed
		.filter((item) => item.provider === provider)
		.map((item) => {
			const model = ctx.modelRegistry.find(provider, item.modelId);
			return {
				...item,
				name: typeof model?.name === "string" && model.name !== item.modelId ? model.name : undefined,
			};
		});
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const input = new Input();
		input.focused = true;
		const key = (binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel", fallback: string) => {
			const value = keybindings.getKeys?.(binding)[0] ?? fallback;
			return (({ up: "Up", down: "Down", enter: "Enter", escape: "Esc" } as Record<string, string>)[value] ?? value.replace(/\b[a-z]/g, (char) => char.toUpperCase()));
		};
		let filteredModels = [...models];
		let selectedIndex = Math.max(0, models.findIndex((item) => item.ref === currentRef));
		const move = (direction: -1 | 1) => {
			if (filteredModels.length === 0) return;
			selectedIndex = (selectedIndex + direction + filteredModels.length) % filteredModels.length;
		};
		const renderModels = (): string[] => {
			if (filteredModels.length === 0) return [theme.fg("warning", "  No matching models")];
			const maxVisible = 10;
			const start = Math.max(0, Math.min(
				selectedIndex - Math.floor(maxVisible / 2),
				filteredModels.length - maxVisible,
			));
			const end = Math.min(start + maxVisible, filteredModels.length);
			const lines = filteredModels.slice(start, end).map((model, offset) => {
				const index = start + offset;
				const details = [model.ref === currentRef ? "current" : undefined, model.name].filter(Boolean).join(" · ");
				const label = `${index === selectedIndex ? "→" : " "} ${model.modelId}${details ? `  ${details}` : ""}`;
				return index === selectedIndex ? theme.fg("accent", label) : label;
			});
			if (start > 0 || end < filteredModels.length) {
				lines.push(theme.fg("dim", `  (${selectedIndex + 1}/${filteredModels.length})`));
			}
			return lines;
		};
		const hint = [
			"type to filter",
			`${key("tui.select.up", "up")}/${key("tui.select.down", "down")} navigate`,
			`${key("tui.select.confirm", "enter")} select`,
			`${key("tui.select.cancel", "escape")} back`,
		].join(" · ");

		return {
			render: (width) => {
				const container = new Container();
				container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
				container.addChild(new Text(theme.fg("accent", theme.bold(`${title}: ${provider}`)), 1, 0));
				container.addChild(new Text(theme.fg("muted", "Type any part of a model ID or name, then press Enter"), 1, 0));
				container.addChild(input);
				container.addChild(new Spacer(1));
				for (const line of renderModels()) container.addChild(new Text(line, 0, 0));
				container.addChild(new Text(theme.fg("dim", hint), 1, 0));
				container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
				return container.render(width);
			},
			invalidate: () => input.invalidate?.(),
			handleInput: (data) => {
				if (keybindings.matches(data, "tui.select.up")) move(-1);
				else if (keybindings.matches(data, "tui.select.down")) move(1);
				else if (keybindings.matches(data, "tui.select.confirm") || data === "\n" || data === "\r") {
					const model = filteredModels[selectedIndex];
					if (model) done(model.ref);
				} else if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
				else {
					input.handleInput(data);
					const query = input.getValue().trim();
					filteredModels = query
						? fuzzyFilter([...models], query, (model) =>
							`${model.modelId} ${model.provider} ${model.ref}${model.name ? ` ${model.name}` : ""}`)
						: [...models];
					selectedIndex = 0;
				}
				tui.requestRender();
			},
		};
	});
}

export async function runAuxiliaryConfigTui(ctx: ExtensionContext, agentDir: string): Promise<void> {
	try {
		await ctx.modelRegistry.refresh();
	} catch (error) {
		ctx.ui.notify(`Could not refresh models: ${error instanceof Error ? error.message : String(error)}`, "warning");
	}
	const modelRefs = availableTextModelRefs(ctx.modelRegistry.getAvailable());
	await runAuxiliaryConfigurator({
		agentDir,
		currentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		modelRefs,
		ui: {
			select: (title, options) => selectMenu(ctx, title, options),
			input: (title, placeholder) => ctx.ui.input(title, placeholder),
			confirm: (title, message) => ctx.ui.confirm(title, message),
			pickModel: (title, current, refs) => pickAvailableModel(ctx, title, current, refs),
			notify: (message, level) => ctx.ui.notify(message, level),
		},
	});
}
