import type { DocsStage } from "./state.ts";
import {
	loadDocsflowConfig,
	updateDocsflowConfig,
	updateDocsflowStageOverride,
	type DocsflowStageOverride,
	type DocsflowThinkingLevel,
} from "./vault.ts";

const STAGES: readonly DocsStage[] = ["research", "product", "interface", "delivery"];
const THINKING_LEVELS: readonly DocsflowThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface DocsflowSettingsUi {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
}

export interface DocsflowModelCapability {
	ref: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<DocsflowThinkingLevel, string | null>>;
}

export interface DocsflowSettingsConfiguratorDeps {
	agentDir: string;
	modelRefs: readonly string[];
	modelCapabilities?: readonly DocsflowModelCapability[];
	stageDefaults?: Partial<Record<DocsStage, DocsflowStageOverride>>;
	ui: DocsflowSettingsUi;
}

function parseTimeout(raw: string): number | undefined {
	if (!/^\d+$/.test(raw.trim())) return undefined;
	const value = Number.parseInt(raw.trim(), 10);
	return value >= 1_000 && value <= 900_000 ? value : undefined;
}

function hasOverride(override: DocsflowStageOverride | undefined): boolean {
	return Boolean(override?.model || override?.thinking || override?.timeoutMs !== undefined);
}

function effectiveStageModel(
	deps: DocsflowSettingsConfiguratorDeps,
	stage: DocsStage,
	override: DocsflowStageOverride | undefined,
): string | undefined {
	return override?.model ?? deps.stageDefaults?.[stage]?.model;
}

function effectiveStageThinking(
	deps: DocsflowSettingsConfiguratorDeps,
	stage: DocsStage,
	override: DocsflowStageOverride | undefined,
): DocsflowThinkingLevel | undefined {
	return override?.thinking ?? deps.stageDefaults?.[stage]?.thinking;
}

function supportsThinkingLevel(
	deps: DocsflowSettingsConfiguratorDeps,
	model: string | undefined,
	thinking: DocsflowThinkingLevel,
): boolean {
	if (!model) return true;
	const capability = deps.modelCapabilities?.find((candidate) => candidate.ref === model);
	if (!capability) return true;
	if (capability.reasoning === false) return thinking === "off";
	const mapped = capability.thinkingLevelMap?.[thinking];
	if (mapped === null) return false;
	return (thinking !== "xhigh" && thinking !== "max") || mapped !== undefined;
}

function patchedStageOverride(
	override: DocsflowStageOverride | undefined,
	patch: Partial<DocsflowStageOverride>,
): DocsflowStageOverride | undefined {
	const next: DocsflowStageOverride = { ...override };
	if (Object.hasOwn(patch, "model")) {
		if (patch.model === undefined) delete next.model;
		else next.model = patch.model;
	}
	if (Object.hasOwn(patch, "thinking")) {
		if (patch.thinking === undefined) delete next.thinking;
		else next.thinking = patch.thinking;
	}
	if (Object.hasOwn(patch, "timeoutMs")) {
		if (patch.timeoutMs === undefined) delete next.timeoutMs;
		else next.timeoutMs = patch.timeoutMs;
	}
	return Object.keys(next).length > 0 ? next : undefined;
}

function supportsEffectiveStageConfig(
	deps: DocsflowSettingsConfiguratorDeps,
	stage: DocsStage,
	override: DocsflowStageOverride | undefined,
): boolean {
	const model = effectiveStageModel(deps, stage, override);
	const thinking = effectiveStageThinking(deps, stage, override);
	return !thinking || supportsThinkingLevel(deps, model, thinking);
}

function notifyUnsupportedEffectiveStageConfig(
	deps: DocsflowSettingsConfiguratorDeps,
	stage: DocsStage,
	override: DocsflowStageOverride | undefined,
): void {
	const model = effectiveStageModel(deps, stage, override);
	const thinking = effectiveStageThinking(deps, stage, override);
	deps.ui.notify(
		`${model ?? "Stage model"} does not support thinking ${thinking ?? "profile default"}; choose a compatible model or thinking level first`,
		"warning",
	);
}

async function editStageOverride(deps: DocsflowSettingsConfiguratorDeps, stage: DocsStage): Promise<void> {
	while (true) {
		const override = loadDocsflowConfig(deps.agentDir).stageOverrides[stage];
		const choice = await deps.ui.select(`${stage} stage override`, [
			`Model: ${override?.model ?? "profile default"}`,
			`Thinking: ${override?.thinking ?? "profile default"}`,
			`Timeout: ${override?.timeoutMs ?? "profile default"}`,
			...(hasOverride(override) ? ["Reset stage override"] : []),
			"Back",
		]);
		if (!choice || choice === "Back") return;
		if (choice === "Reset stage override") {
			if (await deps.ui.confirm(`Reset ${stage} override?`, "Use the packaged profile model, thinking, and timeout again?")) {
				const next = patchedStageOverride(override, { model: undefined, thinking: undefined, timeoutMs: undefined });
				if (!supportsEffectiveStageConfig(deps, stage, next)) {
					notifyUnsupportedEffectiveStageConfig(deps, stage, next);
					continue;
				}
				try {
					updateDocsflowStageOverride(deps.agentDir, stage, { model: undefined, thinking: undefined, timeoutMs: undefined });
					deps.ui.notify(`${stage} override reset`, "info");
				} catch (error) {
					deps.ui.notify(`Failed to update terrific.json: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}
			continue;
		}
		if (choice.startsWith("Model:")) {
			const action = await deps.ui.select(`${stage} model`, ["Set model...", ...(override?.model ? ["Reset override"] : []), "Back"]);
			if (!action || action === "Back") continue;
			if (action === "Reset override") {
				const next = patchedStageOverride(override, { model: undefined });
				if (!supportsEffectiveStageConfig(deps, stage, next)) {
					notifyUnsupportedEffectiveStageConfig(deps, stage, next);
					continue;
				}
				try {
					updateDocsflowStageOverride(deps.agentDir, stage, { model: undefined });
					deps.ui.notify(`${stage} model override reset`, "info");
				} catch (error) {
					deps.ui.notify(`Failed to update terrific.json: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				continue;
			}
			const model = (await deps.ui.input("Model (provider/model)", override?.model ?? ""))?.trim();
			if (!model) continue;
			if (!deps.modelRefs.includes(model)) {
				deps.ui.notify(`Unavailable text model: ${model}`, "warning");
				continue;
			}
			const next = patchedStageOverride(override, { model });
			if (!supportsEffectiveStageConfig(deps, stage, next)) {
				notifyUnsupportedEffectiveStageConfig(deps, stage, next);
				continue;
			}
			try {
				updateDocsflowStageOverride(deps.agentDir, stage, { model });
				deps.ui.notify(`${stage} model: ${model}`, "info");
			} catch (error) {
				deps.ui.notify(`Failed to update terrific.json: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			continue;
		}
		if (choice.startsWith("Thinking:")) {
			const model = effectiveStageModel(deps, stage, override);
			const thinking = await deps.ui.select(`${stage} thinking`, [
				...THINKING_LEVELS.map((level) => {
					const markers = [
						override?.thinking === level ? "current" : "",
						!supportsThinkingLevel(deps, model, level) ? "unavailable" : "",
					].filter(Boolean).join(", ");
					return `${level}${markers ? ` [${markers}]` : ""}`;
				}),
				...(override?.thinking ? ["Reset override"] : []),
				"Back",
			]);
			if (!thinking || thinking === "Back") continue;
			try {
				if (thinking === "Reset override") {
					const next = patchedStageOverride(override, { thinking: undefined });
					if (!supportsEffectiveStageConfig(deps, stage, next)) {
						notifyUnsupportedEffectiveStageConfig(deps, stage, next);
						continue;
					}
					updateDocsflowStageOverride(deps.agentDir, stage, { thinking: undefined });
				} else {
					const level = THINKING_LEVELS.find((value) => thinking === value || thinking.startsWith(`${value} [`));
					if (!level) continue;
					const next = patchedStageOverride(override, { thinking: level });
					if (!supportsEffectiveStageConfig(deps, stage, next)) {
						notifyUnsupportedEffectiveStageConfig(deps, stage, next);
						continue;
					}
					updateDocsflowStageOverride(deps.agentDir, stage, { thinking: level });
				}
				deps.ui.notify(`${stage} thinking updated`, "info");
			} catch (error) {
				deps.ui.notify(`Failed to update terrific.json: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			continue;
		}
		const action = await deps.ui.select(`${stage} timeout`, ["Set value", ...(override?.timeoutMs !== undefined ? ["Reset override"] : []), "Back"]);
		if (!action || action === "Back") continue;
		try {
			if (action === "Reset override") {
				updateDocsflowStageOverride(deps.agentDir, stage, { timeoutMs: undefined });
				deps.ui.notify(`${stage} timeout override reset`, "info");
				continue;
			}
			const raw = await deps.ui.input("Timeout (1000-900000 ms)", String(override?.timeoutMs ?? deps.stageDefaults?.[stage]?.timeoutMs ?? 900_000));
			if (raw === undefined || !raw.trim()) continue;
			const timeoutMs = parseTimeout(raw);
			if (timeoutMs === undefined) {
				deps.ui.notify("Timeout must be an integer from 1000 to 900000", "warning");
				continue;
			}
			updateDocsflowStageOverride(deps.agentDir, stage, { timeoutMs });
			deps.ui.notify(`${stage} timeout: ${timeoutMs}ms`, "info");
		} catch (error) {
			deps.ui.notify(`Failed to update terrific.json: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}
}

async function editStageOverrides(deps: DocsflowSettingsConfiguratorDeps): Promise<void> {
	while (true) {
		const config = loadDocsflowConfig(deps.agentDir);
		const choice = await deps.ui.select("Stage overrides", [
			...STAGES.map((stage) => {
				const override = config.stageOverrides[stage];
				return `${stage}: ${override?.model ?? "profile default"} · ${override?.thinking ?? "profile default"} · ${override?.timeoutMs ?? "profile default"}`;
			}),
			"Back",
		]);
		if (!choice || choice === "Back") return;
		const stage = STAGES.find((value) => choice.startsWith(`${value}:`));
		if (stage) await editStageOverride(deps, stage);
	}
}

export async function runDocsflowSettingsConfigurator(deps: DocsflowSettingsConfiguratorDeps): Promise<void> {
	while (true) {
		const config = loadDocsflowConfig(deps.agentDir);
		const choice = await deps.ui.select("Docsflow settings", [
			`Output location: ${config.vaultEnabled ? "vault" : "local"}`,
			`Config reminder: ${config.configReminder ? "on" : "off"}`,
			`Vault root: ${config.vaultRoot}`,
			`Project base: ${config.projectBase}`,
			"Stage overrides",
			"Show effective config",
			"Back",
		]);
		if (!choice || choice === "Back") return;
		try {
			if (choice.startsWith("Output location:")) {
				const value = await deps.ui.select("Output location", [config.vaultEnabled ? "Vault [current]" : "Vault", config.vaultEnabled ? "Local" : "Local [current]", "Back"]);
				if (!value || value === "Back") continue;
				updateDocsflowConfig(deps.agentDir, { vaultEnabled: value.startsWith("Vault") });
				deps.ui.notify(`Docsflow output: ${value.startsWith("Vault") ? "vault" : "local"}`, "info");
			} else if (choice.startsWith("Config reminder:")) {
				const value = await deps.ui.select("Docsflow reminder", [config.configReminder ? "On [current]" : "On", config.configReminder ? "Off" : "Off [current]", "Back"]);
				if (!value || value === "Back") continue;
				updateDocsflowConfig(deps.agentDir, { configReminder: value.startsWith("On") });
				deps.ui.notify(`Docsflow reminder: ${value.startsWith("On") ? "on" : "off"}`, "info");
			} else if (choice.startsWith("Vault root:")) {
				const value = await deps.ui.input("Vault root", config.vaultRoot);
				if (value?.trim()) updateDocsflowConfig(deps.agentDir, { vaultRoot: value.trim() });
			} else if (choice.startsWith("Project base:")) {
				const value = await deps.ui.input("Project base", config.projectBase);
				if (value?.trim()) updateDocsflowConfig(deps.agentDir, { projectBase: value.trim() });
			} else if (choice === "Stage overrides") {
				await editStageOverrides(deps);
			} else if (choice === "Show effective config") {
				deps.ui.notify(JSON.stringify(config, null, 2), "info");
			}
		} catch (error) {
			deps.ui.notify(`Failed to update terrific.json: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}
}
