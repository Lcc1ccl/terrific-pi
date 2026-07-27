import {
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";

import { patchPrototypeMethod, type PrototypePatchHandle } from "./prototype-patch.ts";
import {
	createToolRenderController,
	type ToolLifecycleEnd,
	type ToolLifecycleStart,
} from "./tool-render.ts";
import { renderUserMessageBox, type CompatibilityTheme } from "./user-message.ts";
import type { PresentationArtifactState } from "../types.ts";

const USER_PATCH_KEY = Symbol.for("terrific-pi.presentation.user-message-patch.v1");
const TOOL_PATCH_KEY = Symbol.for("terrific-pi.presentation.tool-render-patch.v1");

export interface PresentationCompatibilityOptions {
	isUserMessageBoxEnabled(): boolean;
	isCompactToolsEnabled(): boolean;
	isArtifactProjectionEnabled?(): boolean;
	isTerrificNativeActive?(): boolean;
	getTheme(): CompatibilityTheme | undefined;
	resolveSkillName?(args: unknown, cwd: string): string | undefined;
	now?(): number;
}

export interface PresentationCompatibilityHandle {
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
	isArtifactProjectionEnabled: () => false,
	isTerrificNativeActive: () => false,
	getTheme: () => undefined,
};

export function installPresentationCompatibility(
	options: PresentationCompatibilityOptions = DISABLED_OPTIONS,
): PresentationCompatibilityHandle {
	const toolController = createToolRenderController({
		isEnabled: options.isCompactToolsEnabled,
		isArtifactProjectionEnabled: options.isArtifactProjectionEnabled,
		isTerrificNativeActive: options.isTerrificNativeActive,
		getTheme: options.getTheme,
		resolveSkillName: options.resolveSkillName,
		now: options.now ?? Date.now,
	});
	const patches: Array<PrototypePatchHandle | undefined> = [
		patchPrototypeMethod(
			UserMessageComponent.prototype,
			"render",
			USER_PATCH_KEY,
			1,
			(original) => function presentationUserMessageRender(this: unknown, width: number): string[] {
				return renderUserMessageBox(
					this,
					width,
					original as (this: unknown, width: number) => string[],
					options.getTheme(),
					options.isUserMessageBoxEnabled(),
					options.isTerrificNativeActive?.() ?? false,
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
	];
	let active = true;
	return {
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
			toolController.dispose();
			for (const patch of patches.reverse()) patch?.uninstall();
		},
	};
}
