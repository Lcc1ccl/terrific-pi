// Derived from OldSuns/pi-open-tui icons.ts at commit c280fcd.
// Modified to retain statusline emoji/plain modes and add nerd/ascii/auto resolution.

import type { IconMode } from "./types.ts";

export type ResolvedIconMode = Exclude<IconMode, "auto">;

export interface StatuslineGlyphs {
	branch: string;
	worktree: string;
	folder: string;
	context: string;
	runtime: string;
	speed: string;
	latency: string;
	done: string;
	input: string;
	output: string;
	cache: string;
	cost: string;
	stall: string;
	ahead: string;
	behind: string;
	diverged: string;
	conflicted: string;
	stashed: string;
	modified: string;
	staged: string;
	untracked: string;
	renamed: string;
	deleted: string;
	fast: string;
	quota: string;
	success: string;
	error: string;
	duration: string;
}

const GLYPHS: Record<ResolvedIconMode, StatuslineGlyphs> = {
	emoji: {
		branch: "⑂", worktree: "🌳", folder: "📁", context: "🪟",
		runtime: "⚙", speed: "🚀", latency: "⏳", done: "✓", input: "🔼", output: "🔽",
		cache: "🎯", cost: "$", stall: "⚠", ahead: "↑", behind: "↓", diverged: "⇕", conflicted: "=",
		stashed: "≡", modified: "!", staged: "+", untracked: "?", renamed: "→", deleted: "✗",
		fast: "⚡", quota: "📊", success: "✓", error: "✗", duration: "🕒",
	},
	plain: {
		branch: "", worktree: "git", folder: "", context: "context",
		runtime: "runtime", speed: "TPS", latency: "TTFT", done: "run", input: "in", output: "out",
		cache: "cache", cost: "$", stall: "stall", ahead: "ahead ", behind: "behind ", diverged: "diverged ",
		conflicted: "conflict ", stashed: "stash ", modified: "modified ", staged: "staged ", untracked: "untracked ",
		renamed: "renamed ", deleted: "deleted ",
		fast: "fast", quota: "usage", success: "ok", error: "error", duration: "time",
	},
	nerd: {
		branch: "", worktree: "", folder: "", context: "",
		runtime: "", speed: "󰓅", latency: "", done: "", input: "", output: "",
		cache: "", cost: "", stall: "", ahead: "↑", behind: "↓", diverged: "⇕", conflicted: "=",
		stashed: "$", modified: "!", staged: "+", untracked: "?", renamed: "»", deleted: "✘",
		fast: "", quota: "󰓎", success: "", error: "", duration: "",
	},
	ascii: {
		branch: "@", worktree: "*", folder: "/", context: "[]",
		runtime: "R", speed: ">", latency: "~", done: "+", input: "^", output: "v",
		cache: "c", cost: "$", stall: "!", ahead: "^", behind: "v", diverged: "^v", conflicted: "=",
		stashed: "S", modified: "!", staged: "A", untracked: "?", renamed: "r", deleted: "x",
		fast: "F", quota: "%", success: "+", error: "x", duration: "t",
	},
};

const NERD_TERMINALS = new Set(["iTerm.app", "Ghostty", "WezTerm", "kitty", "rio", "tabby", "WindowsTerminal", "vscode"]);

export function resolveIconMode(mode: IconMode, env: NodeJS.ProcessEnv = process.env): ResolvedIconMode {
	if (mode !== "auto") return mode;
	return NERD_TERMINALS.has(env.TERM_PROGRAM ?? "")
		|| NERD_TERMINALS.has(env.LC_TERMINAL ?? "")
		|| env.TERM === "xterm-kitty"
		|| Boolean(env.WT_SESSION)
		? "nerd"
		: "ascii";
}

export function resolveGlyphs(mode: IconMode, env?: NodeJS.ProcessEnv): StatuslineGlyphs {
	return GLYPHS[resolveIconMode(mode, env)];
}

const RUNTIME_NERD: Record<string, string> = {
	nodejs: "", rust: "", go: "", python: "", ruby: "", java: "", swift: "", kotlin: "",
	deno: "", bun: "", php: "", haskell: "", julia: "", lua: "", elixir: "", dart: "",
	zig: "", terraform: "󱁢",
};
const RUNTIME_SHORT: Record<string, string> = {
	nodejs: "node", rust: "rs", go: "go", python: "py", ruby: "rb", java: "java", swift: "swift", kotlin: "kt",
	deno: "deno", bun: "bun", php: "php", haskell: "hs", julia: "jl", lua: "lua", elixir: "ex", dart: "dart",
	zig: "zig", terraform: "tf",
};

export function runtimeSymbol(name: string, mode: IconMode): string {
	const resolved = resolveIconMode(mode);
	return resolved === "nerd" ? (RUNTIME_NERD[name] ?? GLYPHS.nerd.runtime) : (RUNTIME_SHORT[name] ?? name);
}
