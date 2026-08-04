import { basename, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";

import { sanitizeSystemText } from "../system-events.ts";
import type { FileArtifact, PresentationArtifactState } from "../types.ts";
import type { CompatibilityTheme } from "./user-message.ts";

type OriginalRender = (this: unknown, width: number) => string[];

interface ToolResultLike {
	content?: unknown;
	details?: unknown;
	isError?: unknown;
}

interface ToolComponentLike {
	toolName?: unknown;
	toolCallId?: unknown;
	args?: unknown;
	cwd?: unknown;
	expanded?: unknown;
	isPartial?: unknown;
	result?: ToolResultLike;
	executionStarted?: unknown;
	ui?: { requestRender?(): void };
}

export interface ToolLifecycleStart {
	toolCallId: string;
	toolName: string;
	args: unknown;
	cwd: string;
	timestamp?: number;
	requestId?: string;
	skillName?: string;
}

export interface ToolLifecycleEnd {
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
	timestamp?: number;
}

interface ToolState {
	id: string;
	name: string;
	args: unknown;
	cwd: string;
	turnId: number;
	requestId?: string;
	skillName?: string;
	startedAt?: number;
	endedAt?: number;
	result?: ToolResultLike;
	isError: boolean;
	groupId?: number;
	component?: ToolComponentLike;
}

interface ExplorationEpisode {
	id: number;
	members: string[];
}

export interface ToolRenderOptions {
	isEnabled(): boolean;
	isArtifactProjectionEnabled?(): boolean;
	getTheme(): CompatibilityTheme | undefined;
	now(): number;
	resolveSkillName?(args: unknown, cwd: string): string | undefined;
}

export interface ToolRenderController {
	start(input: ToolLifecycleStart): void;
	end(input: ToolLifecycleEnd): void;
	hydrate(entries: readonly unknown[], cwd: string): void;
	boundary(): void;
	setArtifact(state: PresentationArtifactState): void;
	render(instance: unknown, width: number, original: OriginalRender): string[];
	dispose(): void;
}

const EXPLORATION = new Set(["read", "grep", "find", "ls"]);
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArtifactState(value: unknown): value is PresentationArtifactState {
	if (!isRecord(value)
		|| value.version !== 2
		|| typeof value.receiptId !== "string"
		|| typeof value.requestId !== "string"
		|| typeof value.revision !== "number"
		|| !Number.isInteger(value.revision)
		|| typeof value.anchorToolCallId !== "string"
		|| !Array.isArray(value.files)
		|| typeof value.successfulWrites !== "number"
		|| typeof value.failedWrites !== "number"
		|| typeof value.gitReconciled !== "boolean"
		|| typeof value.startedAt !== "number"
		|| typeof value.revisedAt !== "number") return false;
	return value.files.every((file) => isRecord(file)
		&& typeof file.path === "string"
		&& (file.operation === "added" || file.operation === "modified" || file.operation === "deleted" || file.operation === "unknown")
		&& Array.isArray(file.sources)
		&& file.sources.every((source) => typeof source === "string"));
}

function textOutput(result: ToolResultLike | undefined): string {
	if (!Array.isArray(result?.content)) return "";
	for (const item of result.content) {
		if (isRecord(item) && item.type === "text" && typeof item.text === "string") return item.text;
	}
	return "";
}

function outputLineCount(result: ToolResultLike | undefined): number {
	return textOutput(result).split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function exitCode(result: ToolResultLike | undefined): number | undefined {
	if (!isRecord(result?.details)) return undefined;
	const value = result.details.exitCode;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatDuration(ms: number): string {
	const safe = Math.max(0, ms);
	if (safe < 1_000) return `${Math.floor(safe)}ms`;
	const seconds = Math.floor(safe / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

function strong(theme: CompatibilityTheme | undefined, value: string): string {
	try {
		return theme?.bold ? theme.bold(value) : value;
	} catch {
		return value;
	}
}

function color(theme: CompatibilityTheme | undefined, tone: string, value: string): string {
	try {
		return theme ? theme.fg(tone, value) : value;
	} catch {
		return value;
	}
}

function collapseAbsolutePaths(value: string): string {
	return value
		.replace(/(['"])(\/[^'"\r\n]+)\1/g, (_match, quote: string, path: string) => `${quote}${basename(path)}${quote}`)
		.replace(/\b[A-Za-z]:\\[^'"\r\n<>\[\](){},;:]+/g, (path) => win32.basename(path.trim()))
		.replace(/(^|[\s(\[{:<=>])((?:\/[^/\s'"\]),;:}>]+)+)/g, (_match, prefix: string, path: string) => `${prefix}${basename(path)}`);
}

function safeError(result: ToolResultLike | undefined): string {
	const code = exitCode(result);
	const first = textOutput(result).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
	let detail = sanitizeSystemText(first ?? "", 241)
		.replace(/https?:\/\/[^\s'"<>]+/gi, "<url>")
		.replace(/\b(Bearer)\s+\S+/gi, "$1 <redacted>")
		.replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "$1=<redacted>")
		.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/gi, "<redacted>");
	detail = collapseAbsolutePaths(detail);
	if (/^(?:command )?exited with code \d+$/i.test(detail)) detail = "";
	const summary = truncateToWidth(detail || "no error detail", 120, "…");
	return code === undefined ? summary : detail ? `exit ${code} · ${summary}` : `exit ${code}`;
}

function insideWorkspace(path: string, cwd: string): boolean {
	const rel = relative(resolve(cwd), path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function displayPath(value: unknown, cwd: string): string {
	if (typeof value !== "string" || !value.trim()) return "...";
	const target = resolve(cwd, value);
	return sanitizeSystemText(insideWorkspace(target, cwd) ? relative(resolve(cwd), target) || basename(target) : basename(target), 100) || "...";
}

function pathArg(args: unknown): unknown {
	if (!isRecord(args)) return undefined;
	return args.path ?? args.file_path ?? args.filePath ?? args.file;
}

function explorationTarget(state: ToolState): string {
	const path = displayPath(pathArg(state.args), state.cwd);
	if (state.name === "read") return `read ${path}`;
	if (state.name === "grep" || state.name === "find") return `search ${path}`;
	return `list ${path}`;
}

function labelFor(name: string): string {
	const known: Record<string, string> = {
		git_finalize: "Git finalize",
		web_research: "Web research",
		aux_summarize: "Summarize",
		web_search: "Web search",
		fetch_content: "Fetch content",
		get_search_content: "Search content",
		subagent: "Subagent",
	};
	if (known[name]) return known[name]!;
	const words = name.replace(/[._-]+/g, " ").trim();
	return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : "Tool";
}

function customSuccess(state: ToolState): string {
	if (state.name === "git_finalize") {
		const first = textOutput(state.result).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
		if (first) return sanitizeSystemText(first, 100);
	}
	return "completed";
}

function artifactDiff(file: FileArtifact, theme: CompatibilityTheme | undefined): string {
	const additions = file.additions ?? 0;
	const deletions = file.deletions ?? 0;
	if (!additions && !deletions) return "";
	const addition = additions ? color(theme, "success", `+${additions}`) : "";
	const deletion = deletions ? color(theme, "error", `-${deletions}`) : "";
	return ` ${addition}${addition && deletion ? color(theme, "muted", "/") : ""}${deletion}`;
}

function artifactOperation(file: FileArtifact, theme: CompatibilityTheme | undefined): string {
	const marker = { added: "A", modified: "M", deleted: "D", unknown: "?" }[file.operation];
	return `${color(theme, "muted", marker)} ${sanitizeSystemText(file.path, 120)}${artifactDiff(file, theme)}`;
}

function artifactSummary(state: PresentationArtifactState, theme: CompatibilityTheme | undefined): string {
	if (state.reverted) {
		return `${color(theme, "warning", "◆")} ${strong(theme, "Files")} · unchanged · net changes reverted`;
	}
	const additions = state.files.reduce((total, file) => total + (file.additions ?? 0), 0);
	const deletions = state.files.reduce((total, file) => total + (file.deletions ?? 0), 0);
	const shown = state.files.slice(0, 2).map((file) => artifactOperation(file, theme));
	const more = state.files.length - shown.length;
	return `${color(theme, "success", "◆")} ${strong(theme, "Files")} ${state.files.length} changed${artifactDiff({ additions, deletions } as FileArtifact, theme)}${shown.length ? `${color(theme, "muted", " · ")}${shown.join(color(theme, "muted", " · "))}` : ""}${more > 0 ? color(theme, "muted", ` · +${more} more`) : ""}`;
}

function artifactDetails(state: PresentationArtifactState, theme: CompatibilityTheme | undefined): string[] {
	if (state.reverted) return [color(theme, "warning", "Files unchanged · net changes reverted")];
	return state.files.map((file) => artifactOperation(file, theme));
}

function terminal(state: ToolState): boolean {
	return state.endedAt !== undefined || state.result !== undefined;
}

function runningLine(
	label: string,
	state: ToolState,
	theme: CompatibilityTheme | undefined,
	now: number,
): string {
	const elapsed = state.startedAt === undefined ? 0 : now - state.startedAt;
	const frame = SPINNER[Math.floor(Math.max(0, elapsed) / 200) % SPINNER.length]!;
	return `${color(theme, "accent", frame)} ${strong(theme, "Running")} · ${label} · ${formatDuration(elapsed)}`;
}

function terminalLine(state: ToolState, theme: CompatibilityTheme | undefined): string {
	const label = state.skillName ? `Skill(${state.skillName})` : labelFor(state.name);
	const elapsed = state.startedAt !== undefined && state.endedAt !== undefined
		? ` · ${formatDuration(state.endedAt - state.startedAt)}`
		: "";
	if (state.isError) {
		return `${color(theme, "error", "✗")} ${strong(theme, label)} · failed · ${safeError(state.result)}${elapsed}`;
	}
	return `${color(theme, "success", "◆")} ${strong(theme, label)} · ${state.skillName ? "loaded" : customSuccess(state)}${elapsed}`;
}

function bashLine(state: ToolState, theme: CompatibilityTheme | undefined, now: number): string {
	if (!terminal(state)) {
		if (state.startedAt === undefined) return `${color(theme, "muted", "◆")} ${strong(theme, "Bash")} · pending`;
		return runningLine("Bash", state, theme, now);
	}
	const elapsed = state.startedAt !== undefined && state.endedAt !== undefined
		? ` · ${formatDuration(state.endedAt - state.startedAt)}`
		: "";
	const lines = outputLineCount(state.result);
	const lineText = lines > 0 ? `${lines} line${lines === 1 ? "" : "s"}` : "no output";
	if (state.isError) {
		return `${color(theme, "error", "✗")} ${strong(theme, "Bash")} · failed · ${safeError(state.result)} · ${lineText}${elapsed}`;
	}
	return `${color(theme, "success", "◆")} ${strong(theme, "Bash")} · completed · ${lineText}${elapsed}`;
}

function explorationLine(
	episode: ExplorationEpisode,
	states: Map<string, ToolState>,
	theme: CompatibilityTheme | undefined,
	now: number,
): { representative?: string; line?: string } {
	const members = episode.members.map((id) => states.get(id)).filter((state): state is ToolState => Boolean(state));
	const normal = members.filter((state) => !state.isError);
	const representative = normal.at(-1)?.id;
	if (!representative) return {};
	const active = normal.filter((state) => !terminal(state));
	if (active.length > 0) {
		const current = active.at(-1)!;
		const otherCount = Math.max(0, normal.length - 1);
		const started = normal.map((state) => state.startedAt).filter((value): value is number => value !== undefined);
		const elapsed = started.length > 0 ? ` · ${formatDuration(now - Math.min(...started))}` : "";
		const frame = SPINNER[Math.floor(Math.max(0, now - (started.length > 0 ? Math.min(...started) : now)) / 200) % SPINNER.length]!;
		return {
			representative,
			line: `${color(theme, "accent", frame)} ${strong(theme, "Exploring")} · ${explorationTarget(current)}${otherCount > 0 ? ` · +${otherCount}` : ""}${elapsed}`,
		};
	}
	const reads = normal.filter((state) => state.name === "read").length;
	const searches = normal.filter((state) => state.name === "grep" || state.name === "find").length;
	const lists = normal.filter((state) => state.name === "ls").length;
	const parts: string[] = [];
	if (reads) parts.push(`read ${reads} file${reads === 1 ? "" : "s"}`);
	if (searches) parts.push(`searched ${searches} pattern${searches === 1 ? "" : "s"}`);
	if (lists) parts.push(`listed ${lists} director${lists === 1 ? "y" : "ies"}`);
	const starts = normal.map((state) => state.startedAt).filter((value): value is number => value !== undefined);
	const ends = normal.map((state) => state.endedAt).filter((value): value is number => value !== undefined);
	const elapsed = starts.length > 0 && ends.length > 0 ? ` · ${formatDuration(Math.max(...ends) - Math.min(...starts))}` : "";
	return {
		representative,
		line: `${color(theme, "success", "◆")} ${strong(theme, "Explored")} · ${parts.join(" · ")}${elapsed}`,
	};
}

export function createToolRenderController(options: ToolRenderOptions): ToolRenderController {
	const states = new Map<string, ToolState>();
	const episodes = new Map<number, ExplorationEpisode>();
	const artifactsByRequest = new Map<string, PresentationArtifactState>();
	const artifactsByAnchor = new Map<string, PresentationArtifactState>();
	const supersededArtifactAnchors = new Set<string>();
	let activeEpisode: ExplorationEpisode | undefined;
	let nextEpisodeId = 0;
	let currentTurnId = 0;
	let timer: ReturnType<typeof setInterval> | undefined;

	const stopTimer = (): void => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	const resetState = (): void => {
		stopTimer();
		states.clear();
		episodes.clear();
		artifactsByRequest.clear();
		artifactsByAnchor.clear();
		supersededArtifactAnchors.clear();
		activeEpisode = undefined;
		currentTurnId = 0;
		nextEpisodeId = 0;
	};

	const requestRender = (state: ToolState | undefined): void => state?.component?.ui?.requestRender?.();

	const refreshTimer = (): void => {
		const running = options.isEnabled()
			? [...states.values()].filter((state) => state.turnId === currentTurnId && state.name !== "process_update" && state.startedAt !== undefined && !terminal(state) && state.component)
			: [];
		if (running.length === 0) {
			stopTimer();
			return;
		}
		if (timer) return;
		timer = setInterval(() => {
			if (!options.isEnabled()) {
				stopTimer();
				return;
			}
			for (const state of states.values()) {
				if (state.turnId === currentTurnId && state.name !== "process_update" && state.startedAt !== undefined && !terminal(state)) requestRender(state);
			}
		}, 200);
		timer.unref?.();
	};

	const upsertFromInstance = (instance: ToolComponentLike): ToolState | undefined => {
		if (typeof instance.toolName !== "string" || typeof instance.toolCallId !== "string") return undefined;
		let state = states.get(instance.toolCallId);
		if (!state) {
			state = {
				id: instance.toolCallId,
				name: instance.toolName,
				args: instance.args ?? {},
				cwd: typeof instance.cwd === "string" ? instance.cwd : process.cwd(),
				turnId: currentTurnId,
				isError: false,
			};
			states.set(state.id, state);
		}
		state.component = instance;
		state.args = instance.args ?? state.args;
		state.skillName ??= state.name === "read" ? options.resolveSkillName?.(state.args, state.cwd) : undefined;
		if (instance.executionStarted === true && instance.isPartial === true) state.startedAt ??= options.now();
		if (instance.result !== undefined && instance.isPartial === false) {
			state.result = instance.result;
			state.isError = instance.result.isError === true;
			state.endedAt ??= options.now();
		}
		return state;
	};

	const applyArtifact = (artifact: PresentationArtifactState): void => {
		const previous = artifactsByRequest.get(artifact.requestId);
		if (previous && previous.revision >= artifact.revision) return;
		if (previous && previous.anchorToolCallId !== artifact.anchorToolCallId) {
			supersededArtifactAnchors.add(previous.anchorToolCallId);
			artifactsByAnchor.delete(previous.anchorToolCallId);
			requestRender(states.get(previous.anchorToolCallId));
		}
		artifactsByRequest.set(artifact.requestId, artifact);
		artifactsByAnchor.set(artifact.anchorToolCallId, artifact);
		supersededArtifactAnchors.delete(artifact.anchorToolCallId);
		requestRender(states.get(artifact.anchorToolCallId));
	};

	const duplicateFailure = (state: ToolState): { representative: string; count: number } => {
		const turn = [...states.values()].filter((candidate) => candidate.turnId === state.turnId);
		const index = turn.findIndex((candidate) => candidate.id === state.id);
		const key = `${state.name}\0${safeError(state.result)}`;
		let first = index;
		let last = index;
		while (first > 0) {
			const candidate = turn[first - 1]!;
			if (!terminal(candidate) || !candidate.isError || `${candidate.name}\0${safeError(candidate.result)}` !== key) break;
			first -= 1;
		}
		while (last + 1 < turn.length) {
			const candidate = turn[last + 1]!;
			if (!terminal(candidate) || !candidate.isError || `${candidate.name}\0${safeError(candidate.result)}` !== key) break;
			last += 1;
		}
		return { representative: turn[last]?.id ?? state.id, count: last - first + 1 };
	};

	return {
		start(input) {
			const prior = states.get(input.toolCallId);
			const state: ToolState = {
				...(prior ?? {}),
				id: input.toolCallId,
				name: input.toolName,
				args: input.args,
				cwd: input.cwd,
				turnId: prior?.turnId ?? currentTurnId,
				...(input.requestId ? { requestId: input.requestId } : {}),
				...(input.skillName ? { skillName: input.skillName } : {}),
				startedAt: prior?.startedAt ?? input.timestamp ?? options.now(),
				isError: false,
			};
			if (EXPLORATION.has(input.toolName) && !input.skillName) {
				activeEpisode ??= { id: ++nextEpisodeId, members: [] };
				activeEpisode.members.push(input.toolCallId);
				episodes.set(activeEpisode.id, activeEpisode);
				state.groupId = activeEpisode.id;
				const previous = activeEpisode.members.at(-2);
				requestRender(previous ? states.get(previous) : undefined);
			} else {
				activeEpisode = undefined;
			}
			states.set(input.toolCallId, state);
			refreshTimer();
		},
		end(input) {
			const state = states.get(input.toolCallId) ?? {
				id: input.toolCallId,
				name: input.toolName,
				args: {},
				cwd: process.cwd(),
				turnId: currentTurnId,
				isError: false,
			};
			state.result = input.result as ToolResultLike;
			state.isError = input.isError;
			state.endedAt = input.timestamp ?? options.now();
			states.set(input.toolCallId, state);
			if (input.isError) activeEpisode = undefined;
			requestRender(state);
			if (state.groupId) {
				for (const id of episodes.get(state.groupId)?.members ?? []) requestRender(states.get(id));
			}
			if (input.isError) {
				for (const candidate of states.values()) {
					if (candidate.turnId === state.turnId) requestRender(candidate);
				}
			}
			refreshTimer();
		},
		hydrate(entries, cwd) {
			resetState();
			for (const entryValue of entries) {
				if (!isRecord(entryValue)) continue;
				if (entryValue.type === "custom" && entryValue.customType === "presentation-artifact-state-v2") {
					if (isArtifactState(entryValue.data)) applyArtifact(entryValue.data);
					continue;
				}
				if (entryValue.type !== "message" || !isRecord(entryValue.message)) continue;
				const message = entryValue.message;
				if (message.role === "assistant" && Array.isArray(message.content)) {
					currentTurnId += 1;
					activeEpisode = undefined;
					for (const content of message.content) {
						if (!isRecord(content)
							|| content.type !== "toolCall"
							|| typeof content.id !== "string"
							|| typeof content.name !== "string") continue;
						const args = content.arguments ?? {};
						const skillName = content.name === "read" ? options.resolveSkillName?.(args, cwd) : undefined;
						const state: ToolState = {
							id: content.id,
							name: content.name,
							args,
							cwd,
							turnId: currentTurnId,
							...(skillName ? { skillName } : {}),
							isError: false,
						};
						if (EXPLORATION.has(state.name) && !skillName) {
							activeEpisode ??= { id: ++nextEpisodeId, members: [] };
							activeEpisode.members.push(state.id);
							episodes.set(activeEpisode.id, activeEpisode);
							state.groupId = activeEpisode.id;
						} else {
							activeEpisode = undefined;
						}
						states.set(state.id, state);
					}
					activeEpisode = undefined;
				} else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
					const prior = states.get(message.toolCallId);
					const name = typeof message.toolName === "string" ? message.toolName : prior?.name;
					if (!name) continue;
					const state: ToolState = prior ?? {
						id: message.toolCallId,
						name,
						args: {},
						cwd,
						turnId: currentTurnId,
						isError: false,
					};
					state.result = {
						content: message.content,
						details: message.details,
						isError: message.isError === true,
					};
					state.isError = message.isError === true;
					states.set(state.id, state);
				}
			}
			activeEpisode = undefined;
		},
		boundary() {
			activeEpisode = undefined;
			currentTurnId += 1;
			stopTimer();
		},
		setArtifact(artifact) {
			applyArtifact(artifact);
		},
		render(instanceValue, width, original) {
			const instance = instanceValue as ToolComponentLike;
			const state = upsertFromInstance(instance);
			refreshTimer();
			const artifactEnabled = options.isArtifactProjectionEnabled?.() ?? options.isEnabled();
			const artifact = artifactEnabled && typeof instance.toolCallId === "string" ? artifactsByAnchor.get(instance.toolCallId) : undefined;
			const compactTools = options.isEnabled();
			const projectArtifact = Boolean(artifact);
			if ((!compactTools && !projectArtifact) || instance.toolName === "process_update") return original.call(instanceValue, width);
			if (instance.expanded === true) {
				const native = original.call(instanceValue, width);
				return artifact ? [...native, ...artifactDetails(artifact, options.getTheme()).map((line) => truncateToWidth(line, width, "…"))] : native;
			}
			if (typeof instance.toolCallId === "string" && supersededArtifactAnchors.has(instance.toolCallId)) return [];
			if (artifact) {
				if (!compactTools) {
					const native = original.call(instanceValue, width);
					return width < 1 ? native : [...native, "", truncateToWidth(artifactSummary(artifact, options.getTheme()), width, "…")];
				}
				return width < 1 ? [] : ["", truncateToWidth(artifactSummary(artifact, options.getTheme()), width, "…")];
			}
			if (!state) return original.call(instanceValue, width);
			try {
				const duplicate = state.isError ? duplicateFailure(state) : undefined;
				if (duplicate && duplicate.representative !== state.id) return [];
				let line: string | undefined;
				if (state.groupId) {
					if (state.isError) line = terminalLine(state, options.getTheme());
					else {
						const episode = episodes.get(state.groupId);
						const group = episode ? explorationLine(episode, states, options.getTheme(), options.now()) : {};
						if (group.representative !== state.id) return [];
						line = group.line;
					}
				} else if (state.skillName) {
					line = terminal(state)
						? terminalLine(state, options.getTheme())
						: `${color(options.getTheme(), "accent", "◆")} ${strong(options.getTheme(), `Skill(${state.skillName})`)} · loading`;
				} else if (state.name === "bash") {
					line = bashLine(state, options.getTheme(), options.now());
				} else if (EXPLORATION.has(state.name)) {
					if (state.isError) line = terminalLine(state, options.getTheme());
					else if (!terminal(state)) line = runningLine(explorationTarget(state), state, options.getTheme(), options.now());
					else line = `${color(options.getTheme(), "success", "◆")} ${strong(options.getTheme(), "Explored")} · ${explorationTarget(state)}`;
				} else {
					line = terminal(state)
						? terminalLine(state, options.getTheme())
						: runningLine(labelFor(state.name), state, options.getTheme(), options.now());
				}
				if (line && duplicate && duplicate.count > 1) line += color(options.getTheme(), "muted", ` · ×${duplicate.count}`);
				refreshTimer();
				return !line || width < 1 ? [] : ["", truncateToWidth(line, width, "…")];
			} catch {
				return original.call(instanceValue, width);
			}
		},
		dispose() {
			resetState();
		},
	};
}
