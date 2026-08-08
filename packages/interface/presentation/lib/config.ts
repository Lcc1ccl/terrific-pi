import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { PresentationConfig } from "./types.ts";

const CONFIG_FILE = "terrific.json";
const MAX_EXPANDED_ARTIFACTS = 32;

export const DEFAULT_PRESENTATION_CONFIG: PresentationConfig = {
	enabled: true,
	style: "omp",
	workspace: true,
	systemEvents: true,
	artifacts: true,
	userMessageBox: true,
	compactTools: true,
	maxExpandedArtifacts: 16,
};

export type PresentationConfigLoadResult = { config: PresentationConfig; error?: string };
export type PresentationConfigWriteResult = { ok: true; path: string } | { ok: false; path: string; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDefault(): PresentationConfig {
	return { ...DEFAULT_PRESENTATION_CONFIG };
}

function normalizeConfig(value: unknown): PresentationConfig {
	if (!isRecord(value)) return cloneDefault();
	const max = typeof value.maxExpandedArtifacts === "number" && Number.isInteger(value.maxExpandedArtifacts)
		? Math.min(MAX_EXPANDED_ARTIFACTS, Math.max(1, value.maxExpandedArtifacts))
		: DEFAULT_PRESENTATION_CONFIG.maxExpandedArtifacts;
	return {
		enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_PRESENTATION_CONFIG.enabled,
		style: value.style === "classic" || value.style === "omp" ? value.style : DEFAULT_PRESENTATION_CONFIG.style,
		workspace: typeof value.workspace === "boolean" ? value.workspace : DEFAULT_PRESENTATION_CONFIG.workspace,
		systemEvents: typeof value.systemEvents === "boolean" ? value.systemEvents : DEFAULT_PRESENTATION_CONFIG.systemEvents,
		artifacts: typeof value.artifacts === "boolean" ? value.artifacts : DEFAULT_PRESENTATION_CONFIG.artifacts,
		userMessageBox: typeof value.userMessageBox === "boolean" ? value.userMessageBox : DEFAULT_PRESENTATION_CONFIG.userMessageBox,
		compactTools: typeof value.compactTools === "boolean" ? value.compactTools : DEFAULT_PRESENTATION_CONFIG.compactTools,
		maxExpandedArtifacts: max,
	};
}

export function presentationConfigPath(
	agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
): string {
	return join(agentDir, CONFIG_FILE);
}

export function loadPresentationConfig(
	agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
): PresentationConfigLoadResult {
	const path = presentationConfigPath(agentDir);
	if (!existsSync(path)) return { config: cloneDefault() };
	try {
		const root: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(root)) throw new Error("terrific.json root must be an object");
		if (Object.hasOwn(root, "presentation") && !isRecord(root.presentation)) {
			throw new Error("presentation must be a JSON object");
		}
		return { config: normalizeConfig(root.presentation) };
	} catch (error) {
		return {
			config: { ...cloneDefault(), enabled: false },
			error: `Failed to parse ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function updatePresentationConfig(
	agentDir: string,
	patch: Partial<PresentationConfig>,
): PresentationConfigWriteResult {
	const path = presentationConfigPath(agentDir);
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	} catch (error) {
		return { ok: false, path, error: error instanceof Error ? error.message : String(error) };
	}

	const lockPath = `${path}.lock`;
	try {
		const descriptor = openSync(lockPath, "wx", 0o600);
		closeSync(descriptor);
	} catch (error) {
		return { ok: false, path, error: `Failed to lock ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}` };
	}

	const temporary = join(dirname(path), `.${CONFIG_FILE}.${process.pid}.${randomUUID()}.tmp`);
	try {
		let root: Record<string, unknown> = {};
		if (existsSync(path)) {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!isRecord(parsed)) return { ok: false, path, error: `${CONFIG_FILE} root must be an object` };
			root = parsed;
		}
		if (Object.hasOwn(root, "presentation") && !isRecord(root.presentation)) {
			return { ok: false, path, error: "presentation must be a JSON object" };
		}
		root.presentation = { ...(isRecord(root.presentation) ? root.presentation : {}), ...patch };
		const descriptor = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(descriptor, `${JSON.stringify(root, null, 2)}\n`, "utf8");
			chmodSync(temporary, existsSync(path) ? statSync(path).mode & 0o777 : 0o600);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temporary, path);
		return { ok: true, path };
	} catch (error) {
		return { ok: false, path, error: error instanceof Error ? error.message : String(error) };
	} finally {
		try {
			unlinkSync(temporary);
		} catch {}
		try {
			unlinkSync(lockPath);
		} catch {}
	}
}
