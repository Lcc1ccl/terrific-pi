import * as CodingAgent from "@earendil-works/pi-coding-agent";

import { createAssistantRenderController } from "./assistant-message.ts";

import { patchPrototypeMethod, type PrototypePatchHandle } from "./prototype-patch.ts";
import {
	createToolRenderController,
	type ToolLifecycleEnd,
	type ToolLifecycleStart,
} from "./tool-render.ts";
import { renderUserMessageBox, type CompatibilityTheme } from "./user-message.ts";
import type { PresentationArtifactState } from "../types.ts";

const SUPPORTED_HOST_VERSIONS = new Set(["0.81.1", "0.83.0", "0.84.1"]);
const REQUIRED_COMPONENT_METHODS = {
	AssistantMessageComponent: ["render", "updateContent", "setHideThinkingBlock"],
	UserMessageComponent: ["render"],
	ToolExecutionComponent: ["render", "updateArgs", "updateResult", "setExpanded"],
} as const;

export type PresentationHostProbe =
	| { supported: true; version: string }
	| { supported: false; version: string; reason: string };

export function probePresentationHost(value: unknown): PresentationHostProbe {
	const host = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
	const version = typeof host.VERSION === "string" ? host.VERSION : "unknown";
	if (!SUPPORTED_HOST_VERSIONS.has(version)) {
		return { supported: false, version, reason: `unsupported Pi version ${version}` };
	}
	for (const [name, methods] of Object.entries(REQUIRED_COMPONENT_METHODS)) {
		const component = host[name];
		if (typeof component !== "function") {
			return { supported: false, version, reason: `missing ${name} constructor` };
		}
		const prototype = (component as unknown as { prototype?: Record<string, unknown> }).prototype;
		for (const method of methods) {
			if (typeof prototype?.[method] !== "function") {
				return { supported: false, version, reason: `missing ${name}.prototype.${method}` };
			}
		}
	}
	return { supported: true, version };
}

const ASSISTANT_PATCH_KEY = Symbol.for("terrific-pi.presentation.assistant-message-patch.v1");
const USER_PATCH_KEY = Symbol.for("terrific-pi.presentation.user-message-patch.v1");
const TOOL_PATCH_KEY = Symbol.for("terrific-pi.presentation.tool-render-patch.v1");

export interface PresentationCompatibilityOptions {
	isUserMessageBoxEnabled(): boolean;
	isCompactToolsEnabled(): boolean;
	isOmpStyleEnabled?(): boolean;
	isArtifactProjectionEnabled?(): boolean;
	getTheme(): CompatibilityTheme | undefined;
	resolveSkillName?(args: unknown, cwd: string): string | undefined;
	now?(): number;
}

export interface PresentationCompatibilityHandle {
	host: PresentationHostProbe;
	assistantStart(message: unknown): void;
	assistantUpdate(message: unknown): void;
	assistantEnd(message: unknown): void;
	assistantReset(): void;
	toolStart(input: ToolLifecycleStart): void;
	toolEnd(input: ToolLifecycleEnd): void;
	hydrate(entries: readonly unknown[], cwd: string): void;
	toolBoundary(): void;
	setArtifact(state: PresentationArtifactState): void;
	uninstall(): void;
}

const DISABLED_OPTIONS: PresentationCompatibilityOptions = {
	isUserMessageBoxEnabled: () => false,
	isCompactToolsEnabled: () => false,
	isOmpStyleEnabled: () => false,
	isArtifactProjectionEnabled: () => false,
	getTheme: () => undefined,
};

export function installPresentationCompatibility(
	options: PresentationCompatibilityOptions = DISABLED_OPTIONS,
	hostNamespace: unknown = CodingAgent,
): PresentationCompatibilityHandle {
	const ompStyleEnabled = () => options.isOmpStyleEnabled?.() ?? false;
	const assistantController = createAssistantRenderController({
		isEnabled: ompStyleEnabled,
		getTheme: options.getTheme,
		now: options.now ?? Date.now,
	});
	const toolController = createToolRenderController({
		isEnabled: options.isCompactToolsEnabled,
		isOmpStyleEnabled: ompStyleEnabled,
		isArtifactProjectionEnabled: options.isArtifactProjectionEnabled,
		getTheme: options.getTheme,
		resolveSkillName: options.resolveSkillName,
		now: options.now ?? Date.now,
	});
	const host = hostNamespace as Record<string, unknown>;
	const AssistantMessageComponent = host.AssistantMessageComponent as { prototype: object };
	const UserMessageComponent = host.UserMessageComponent as { prototype: object };
	const ToolExecutionComponent = host.ToolExecutionComponent as { prototype: object };
	const hostProbe = probePresentationHost(hostNamespace);
	const compatibleHost = hostProbe.supported;
	const patches: Array<PrototypePatchHandle | undefined> = compatibleHost ? [
		patchPrototypeMethod(
			AssistantMessageComponent.prototype,
			"render",
			ASSISTANT_PATCH_KEY,
			1,
			(original) => function presentationAssistantMessageRender(this: unknown, width: number): string[] {
				return assistantController.render(
					this,
					width,
					original as (this: unknown, width: number) => string[],
				);
			},
		),
		patchPrototypeMethod(
			UserMessageComponent.prototype,
			"render",
			USER_PATCH_KEY,
			1,
			(original) => function presentationUserMessageRender(this: unknown, width: number): string[] {
				if (ompStyleEnabled()) return original.call(this, Math.max(0, Math.floor(width)));
				return renderUserMessageBox(
					this,
					width,
					original as (this: unknown, width: number) => string[],
					options.getTheme(),
					options.isUserMessageBoxEnabled(),
				);
			},
		),
		patchPrototypeMethod(
			ToolExecutionComponent.prototype,
			"render",
			TOOL_PATCH_KEY,
			1,
			(original) => function presentationToolRender(this: unknown, width: number): string[] {
				return toolController.render(
					this,
					width,
					original as (this: unknown, width: number) => string[],
				);
			},
		),
	] : [];
	let active = true;
	return {
		host: hostProbe,
		assistantStart(message) {
			assistantController.start(message);
		},
		assistantUpdate(message) {
			assistantController.update(message);
		},
		assistantEnd(message) {
			assistantController.end(message);
		},
		assistantReset() {
			assistantController.reset();
		},
		toolStart(input) {
			toolController.start(input);
		},
		toolEnd(input) {
			toolController.end(input);
		},
		hydrate(entries, cwd) {
			toolController.hydrate(entries, cwd);
		},
		toolBoundary() {
			toolController.boundary();
		},
		setArtifact(state) {
			toolController.setArtifact(state);
		},
		uninstall() {
			if (!active) return;
			active = false;
			assistantController.reset();
			toolController.dispose();
			for (const patch of patches.reverse()) patch?.uninstall();
		},
	};
}
