// Derived from OldSuns/pi-open-tui runtime.ts at commit c280fcd.
// Modified to use injected pi.exec, deterministic ambiguity, and cwd-scoped LRU caching.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface RuntimeInfo {
	name: string;
	version?: string;
	ambiguous?: boolean;
}

type Exec = (
	command: string,
	args: string[],
	options: { cwd: string; timeout: number },
) => Promise<{ code: number; stdout: string; stderr?: string }>;

type RuntimeDef = {
	name: string;
	markers: readonly string[];
	command?: string;
	args?: string[];
	pattern?: RegExp;
};

const RUNTIMES: readonly RuntimeDef[] = [
	{ name: "nodejs", markers: ["package.json", ".nvmrc", ".node-version"], command: "node", args: ["--version"], pattern: /v(\d+\.\d+\.\d+)/ },
	{ name: "rust", markers: ["Cargo.toml"], command: "rustc", args: ["--version"], pattern: /rustc\s+(\d+\.\d+\.\d+)/ },
	{ name: "go", markers: ["go.mod"], command: "go", args: ["version"], pattern: /go(\d+\.\d+(?:\.\d+)?)/ },
	{ name: "python", markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile", ".python-version"], command: "python3", args: ["--version"], pattern: /Python\s+(\d+\.\d+\.\d+)/ },
	{ name: "ruby", markers: ["Gemfile", ".ruby-version"], command: "ruby", args: ["--version"], pattern: /ruby\s+(\d+\.\d+\.\d+)/ },
	{ name: "java", markers: ["pom.xml", "build.gradle", "build.gradle.kts", ".java-version"], command: "java", args: ["-version"], pattern: /version\s+"(\d+\.\d+(?:\.\d+)*)"/ },
	{ name: "swift", markers: ["Package.swift"], command: "swift", args: ["--version"], pattern: /Swift\s+(\d+\.\d+(?:\.\d+)?)/ },
	{ name: "kotlin", markers: ["settings.gradle.kts"] },
	{ name: "deno", markers: ["deno.json", "deno.jsonc", "deno.lock"], command: "deno", args: ["--version"], pattern: /deno\s+(\d+\.\d+\.\d+)/ },
	{ name: "bun", markers: ["bun.lock", "bun.lockb"], command: "bun", args: ["--version"], pattern: /(\d+\.\d+\.\d+)/ },
	{ name: "php", markers: ["composer.json"], command: "php", args: ["--version"], pattern: /PHP\s+(\d+\.\d+\.\d+)/ },
	{ name: "haskell", markers: ["stack.yaml", "cabal.project"] },
	{ name: "julia", markers: ["Project.toml", "Manifest.toml"], command: "julia", args: ["--version"], pattern: /julia\s+(\d+\.\d+\.\d+)/i },
	{ name: "lua", markers: ["stylua.toml", ".luarc.json"], command: "lua", args: ["-v"], pattern: /Lua\s+(\d+\.\d+)/ },
	{ name: "elixir", markers: ["mix.exs"], command: "elixir", args: ["--version"], pattern: /Elixir\s+(\d+\.\d+\.\d+)/ },
	{ name: "erlang", markers: ["rebar.config", "erlang.mk"] },
	{ name: "gleam", markers: ["gleam.toml"], command: "gleam", args: ["--version"], pattern: /gleam\s+(\d+\.\d+\.\d+)/i },
	{ name: "crystal", markers: ["shard.yml"] },
	{ name: "dart", markers: ["pubspec.yaml"], command: "dart", args: ["--version"], pattern: /Dart\s+SDK\s+version:\s+(\d+\.\d+\.\d+)/ },
	{ name: "zig", markers: ["build.zig"], command: "zig", args: ["version"], pattern: /(\d+\.\d+\.\d+)/ },
	{ name: "ocaml", markers: ["dune", "dune-project"] },
	{ name: "clojure", markers: ["project.clj", "deps.edn"] },
	{ name: "scala", markers: ["build.sbt"] },
	{ name: "elm", markers: ["elm.json"] },
	{ name: "terraform", markers: ["main.tf", "variables.tf"] },
	{ name: "helm", markers: ["Chart.yaml", "helmfile.yaml"] },
	{ name: "fortran", markers: ["fpm.toml"] },
	{ name: "purescript", markers: ["spago.dhall", "spago.yaml"] },
	{ name: "v", markers: ["v.mod", "vpkg.json"] },
	{ name: "xmake", markers: ["xmake.lua"] },
	{ name: "meson", markers: ["meson.build"] },
	{ name: "nix", markers: ["flake.nix", "shell.nix"] },
	{ name: "pixi", markers: ["pixi.toml", "pixi.lock"] },
	{ name: "pulumi", markers: ["Pulumi.yaml", "Pulumi.yml"] },
	{ name: "typst", markers: ["template.typ"] },
	{ name: "buf", markers: ["buf.yaml", "buf.gen.yaml", "buf.work.yaml"] },
	{ name: "dotnet", markers: ["global.json", "Directory.Build.props"] },
];

const GENERIC_MARKERS = new Set(["Makefile", "CMakeLists.txt", "CMakeCache.txt"]);
const RUNTIME_MARKERS = new Set(RUNTIMES.flatMap((runtime) => runtime.markers));
const cache = new Map<string, { fingerprint: string; value: RuntimeInfo | undefined }>();
const CACHE_MAX = 32;

function directoryState(cwd: string): { entries: string[]; fingerprint: string } {
	try {
		const entries = readdirSync(cwd).sort();
		const fingerprint = entries
			.filter((entry) => RUNTIME_MARKERS.has(entry) || GENERIC_MARKERS.has(entry))
			.map((entry) => {
			try {
				const stat = statSync(join(cwd, entry));
				return `${entry}:${stat.mtimeMs}:${stat.size}`;
			} catch {
				return entry;
			}
			}).join("\0");
		return { entries, fingerprint };
	} catch {
		return { entries: [], fingerprint: "" };
	}
}

async function version(def: RuntimeDef, cwd: string, exec: Exec): Promise<string | undefined> {
	if (!def.command) return undefined;
	try {
		const result = await exec(def.command, def.args ?? [], { cwd, timeout: 2_500 });
		if (result.code !== 0) return undefined;
		const output = `${result.stdout}\n${result.stderr ?? ""}`;
		return def.pattern?.exec(output)?.[1] ?? (output.trim() || undefined);
	} catch {
		return undefined;
	}
}

export async function readRuntimeInfo(cwd: string, exec: Exec): Promise<RuntimeInfo | undefined> {
	const { entries, fingerprint } = directoryState(cwd);
	const cached = cache.get(cwd);
	if (cached?.fingerprint === fingerprint) {
		cache.delete(cwd);
		cache.set(cwd, cached);
		return cached.value;
	}
	const names = new Set(entries);
	const matches = RUNTIMES.filter((def) => def.markers.some((marker) => names.has(marker)));
	let value: RuntimeInfo | undefined;
	if (matches.length > 1 || (matches.length === 0 && entries.some((entry) => GENERIC_MARKERS.has(entry)))) {
		value = { name: "runtime", ambiguous: true };
	} else if (matches.length === 1) {
		const def = matches[0]!;
		const detectedVersion = await version(def, cwd, exec);
		value = { name: def.name, ...(detectedVersion ? { version: detectedVersion } : {}) };
	}
	cache.delete(cwd);
	cache.set(cwd, { fingerprint, value });
	while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
	return value;
}

export function clearRuntimeInfoCache(): void {
	cache.clear();
}

export function runtimeInfoCacheSize(): number {
	return cache.size;
}
