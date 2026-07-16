import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

type RunState = "Ready" | "Working" | "Thinking";
type Rgb = readonly [number, number, number];
type Accent = "model" | "path" | "branch" | "state" | "usage" | "progress";

interface BranchChangeStats {
	additions: number;
	deletions: number;
}

interface Palette {
	model: Rgb;
	path: Rgb;
	branch: Rgb;
	state: Rgb;
	usage: Rgb;
	progress: Rgb;
	separator: Rgb;
}

// Mirrors openai/codex rust-v0.144.1 status_line_style.rs with its adaptive
// Catppuccin defaults. Segment colors are softened to 85% saturation below.
const DARK_PALETTE: Palette = {
	model: [137, 180, 250],
	path: [166, 227, 161],
	branch: [250, 179, 135],
	state: [203, 166, 247],
	usage: [249, 226, 175],
	progress: [166, 227, 161],
	separator: [118, 129, 140],
};

const LIGHT_PALETTE: Palette = {
	model: [30, 102, 245],
	path: [64, 160, 43],
	branch: [254, 100, 11],
	state: [136, 57, 239],
	usage: [223, 142, 29],
	progress: [64, 160, 43],
	separator: [108, 112, 134],
};

const STATUS_LINE_SEPARATOR = " · ";
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function softenColor([red, green, blue]: Rgb): Rgb {
	const luma = Math.floor((77 * red + 150 * green + 29 * blue) / 256);
	const soften = (channel: number) => Math.floor((channel * 85 + luma * 15 + 50) / 100);
	return [soften(red), soften(green), soften(blue)];
}

function foreground([red, green, blue]: Rgb, text: string): string {
	return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
}

function styled(palette: Palette, accent: Accent, text: string): string {
	return foreground(softenColor(palette[accent]), text);
}

function formatTokensCompact(value: number): string {
	const count = Math.max(0, value);
	if (count === 0) return "0";
	if (count < 1_000) return String(count);

	let scaled: number;
	let suffix: string;
	if (count >= 1_000_000_000_000) {
		scaled = count / 1_000_000_000_000;
		suffix = "T";
	} else if (count >= 1_000_000_000) {
		scaled = count / 1_000_000_000;
		suffix = "B";
	} else if (count >= 1_000_000) {
		scaled = count / 1_000_000;
		suffix = "M";
	} else {
		scaled = count / 1_000;
		suffix = "K";
	}

	const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
	return `${scaled.toFixed(decimals).replace(/\.0+$|(?<=\.[0-9]*)0+$/g, "")}${suffix}`;
}

function formatCwd(cwd: string): string {
	const home = resolve(homedir());
	const absolute = resolve(cwd);
	const fromHome = relative(home, absolute);
	const insideHome = fromHome === "" || (fromHome !== ".." && !fromHome.startsWith(`..${sep}`));

	if (!insideHome) return absolute;
	return fromHome === "" ? "~" : `~${sep}${fromHome}`;
}

function sanitizeStatus(text: string): string {
	return text
		.replace(ANSI_PATTERN, "")
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function parseNumstat(output: string): BranchChangeStats {
	let additions = 0;
	let deletions = 0;

	for (const line of output.split("\n")) {
		const [added, deleted] = line.split("\t", 3);
		additions += Number.parseInt(added ?? "", 10) || 0;
		deletions += Number.parseInt(deleted ?? "", 10) || 0;
	}

	return { additions, deletions };
}

export default function codexStatusline(pi: ExtensionAPI) {
	let runState: RunState = "Ready";
	let branchChanges: BranchChangeStats | undefined;
	let gitRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	let renderRequest: (() => void) | undefined;
	const activeTools = new Set<string>();
	const defaultBranchCache = new Map<string, string | null>();

	const requestRender = () => renderRequest?.();

	const git = async (cwd: string, args: string[]): Promise<string | undefined> => {
		const result = await pi.exec("git", args, { cwd, timeout: 2_000 });
		return result.code === 0 ? result.stdout.trim() : undefined;
	};

	const gitRefExists = async (cwd: string, reference: string): Promise<boolean> =>
		(await git(cwd, ["rev-parse", "--verify", "--quiet", reference])) !== undefined;

	const resolveDefaultBranch = async (cwd: string): Promise<string | undefined> => {
		const cached = defaultBranchCache.get(cwd);
		if (cached !== undefined) return cached ?? undefined;

		const remotes = (await git(cwd, ["remote"]))?.split("\n").filter(Boolean) ?? [];
		const originIndex = remotes.indexOf("origin");
		if (originIndex > 0) remotes.unshift(...remotes.splice(originIndex, 1));

		for (const remote of remotes) {
			const remoteHead = `refs/remotes/${remote}/HEAD`;
			const symbolicRef = await git(cwd, ["symbolic-ref", "--quiet", remoteHead]);
			if (symbolicRef && await gitRefExists(cwd, symbolicRef)) {
				defaultBranchCache.set(cwd, symbolicRef);
				return symbolicRef;
			}

			const remoteInfo = await git(cwd, ["remote", "show", remote]);
			const headName = remoteInfo
				?.split("\n")
				.map((line) => line.trim())
				.find((line) => line.startsWith("HEAD branch:"))
				?.slice("HEAD branch:".length)
				.trim();
			const remoteRef = headName ? `refs/remotes/${remote}/${headName}` : undefined;
			if (remoteRef && await gitRefExists(cwd, remoteRef)) {
				defaultBranchCache.set(cwd, remoteRef);
				return remoteRef;
			}
		}

		for (const candidate of ["refs/heads/main", "refs/heads/master"]) {
			if (await gitRefExists(cwd, candidate)) {
				defaultBranchCache.set(cwd, candidate);
				return candidate;
			}
		}

		defaultBranchCache.set(cwd, null);
		return undefined;
	};

	const refreshBranchChanges = async (cwd: string) => {
		const defaultBranch = await resolveDefaultBranch(cwd);
		const mergeBase = defaultBranch ? await git(cwd, ["merge-base", "HEAD", defaultBranch]) : undefined;
		const numstat = mergeBase ? await git(cwd, ["diff", "--numstat", `${mergeBase}..HEAD`]) : undefined;
		branchChanges = numstat === undefined ? undefined : parseNumstat(numstat);
		requestRender();
	};

	const scheduleGitRefresh = (cwd: string, delay = 120) => {
		if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
		gitRefreshTimer = setTimeout(() => {
			gitRefreshTimer = undefined;
			void refreshBranchChanges(cwd).catch(() => {
				branchChanges = undefined;
				requestRender();
			});
		}, delay);
	};

	const setRunState = (state: RunState) => {
		runState = state;
		requestRender();
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		runState = "Ready";
		branchChanges = undefined;
		activeTools.clear();

		ctx.ui.setFooter((tui, theme, footerData) => {
			const localRenderRequest = () => tui.requestRender();
			renderRequest = localRenderRequest;
			const unsubscribeBranch = footerData.onBranchChange(() => {
				scheduleGitRefresh(ctx.cwd, 0);
				tui.requestRender();
			});

			return {
				dispose() {
					unsubscribeBranch();
					if (renderRequest === localRenderRequest) renderRequest = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const palette = theme.name?.toLowerCase().includes("light") ? LIGHT_PALETTE : DARK_PALETTE;
					let totalInput = 0;
					let totalOutput = 0;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type !== "message" || entry.message.role !== "assistant") continue;
						const message = entry.message as AssistantMessage;
						totalInput += message.usage.input;
						totalOutput += message.usage.output;
					}

					const usage = ctx.getContextUsage();
					const remaining = usage?.percent === null || usage?.percent === undefined
						? undefined
						: Math.max(0, Math.min(100, Math.round(100 - usage.percent)));
					const model = ctx.model?.id ?? "no-model";
					const thinking = ctx.model?.reasoning ? pi.getThinkingLevel() : "off";
					const modelWithReasoning = thinking === "off" ? model : `${model} ${thinking}`;
					const branch = footerData.getGitBranch();
					const branchDiff = branchChanges
						? branchChanges.additions === 0 && branchChanges.deletions === 0
							? "No changes"
							: `+${branchChanges.additions} -${branchChanges.deletions}`
						: undefined;
					const taskProgress = Array.from(footerData.getExtensionStatuses().values())
						.map(sanitizeStatus)
						.filter(Boolean)
						.join(" ");

					const segments = [
						styled(palette, "path", formatCwd(ctx.cwd)),
						styled(palette, "model", modelWithReasoning),
						styled(palette, "usage", `${formatTokensCompact(totalInput)} in`),
						styled(palette, "usage", `${formatTokensCompact(totalOutput)} out`),
						remaining === undefined ? undefined : styled(palette, "usage", `Context ${remaining}% left`),
						branch ? styled(palette, "branch", branch) : undefined,
						branchDiff ? styled(palette, "branch", branchDiff) : undefined,
						taskProgress ? styled(palette, "progress", taskProgress) : undefined,
						styled(palette, "state", runState),
					].filter((segment): segment is string => Boolean(segment));

					const separator = foreground(palette.separator, STATUS_LINE_SEPARATOR);
					const ellipsis = foreground(palette.separator, "…");
					const line = `  ${segments.join(separator)}`;
					return [truncateToWidth(line, Math.max(1, width), ellipsis)];
				},
			};
		});

		scheduleGitRefresh(ctx.cwd, 0);
	});

	pi.on("agent_start", async () => setRunState("Thinking"));
	pi.on("turn_start", async () => setRunState("Thinking"));
	pi.on("agent_settled", async (_event, ctx) => {
		activeTools.clear();
		setRunState("Ready");
		scheduleGitRefresh(ctx.cwd, 0);
	});
	pi.on("tool_execution_start", async (event) => {
		activeTools.add(event.toolCallId);
		setRunState("Working");
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		activeTools.delete(event.toolCallId);
		setRunState(activeTools.size > 0 ? "Working" : "Thinking");
		scheduleGitRefresh(ctx.cwd);
	});
	pi.on("model_select", async () => requestRender());
	pi.on("thinking_level_select", async () => requestRender());
	pi.on("session_compact", async () => requestRender());
	pi.on("session_shutdown", async () => {
		if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
		gitRefreshTimer = undefined;
		renderRequest = undefined;
		activeTools.clear();
	});
}
