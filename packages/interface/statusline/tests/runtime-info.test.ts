import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	clearRuntimeInfoCache,
	readRuntimeInfo,
	runtimeInfoCacheSize,
} from "../lib/runtime-info.ts";

const dirs: string[] = [];
function project(files: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "statusline-runtime-"));
	dirs.push(dir);
	for (const [name, text] of Object.entries(files)) {
		const path = join(dir, name);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, text);
	}
	return dir;
}

const outputs: Record<string, string> = {
	node: "v22.10.0\n",
	python3: "Python 3.12.4\n",
	rustc: "rustc 1.82.0 (x)\n",
	go: "go version go1.23.2 linux/amd64\n",
};

function executor(calls: unknown[][] = []) {
	return async (...args: unknown[]) => {
		calls.push(args);
		return { code: 0, stdout: outputs[String(args[0])] ?? "", stderr: "" };
	};
}

afterEach(() => {
	clearRuntimeInfoCache();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readRuntimeInfo", () => {
	it("detects and versions Node Python Rust and Go through injected pi.exec", async () => {
		for (const [marker, expected] of [
			["package.json", { name: "nodejs", version: "22.10.0" }],
			["pyproject.toml", { name: "python", version: "3.12.4" }],
			["Cargo.toml", { name: "rust", version: "1.82.0" }],
			["go.mod", { name: "go", version: "1.23.2" }],
		] as const) {
			const calls: unknown[][] = [];
			const cwd = project({ [marker]: "{}" });
			assert.deepEqual(await readRuntimeInfo(cwd, executor(calls)), expected);
			assert.equal((calls[0]?.[2] as { timeout?: number }).timeout, 2_500);
		}
	});

	it("prefers a dedicated manifest over generic Make/CMake markers", async () => {
		const cwd = project({ "package.json": "{}", "Makefile": "all:", "CMakeLists.txt": "project(x)" });
		assert.deepEqual(await readRuntimeInfo(cwd, executor()), { name: "nodejs", version: "22.10.0" });
	});

	it("returns runtime ambiguity for multiple dedicated languages and C/CMake conflicts", async () => {
		const multi = project({ "package.json": "{}", "Cargo.toml": "" });
		assert.deepEqual(await readRuntimeInfo(multi, executor()), { name: "runtime", ambiguous: true });
		const cBuild = project({ "Makefile": "", "CMakeLists.txt": "" });
		assert.deepEqual(await readRuntimeInfo(cBuild, executor()), { name: "runtime", ambiguous: true });
	});

	it("keeps detected runtime when version command fails or times out", async () => {
		const cwd = project({ "go.mod": "module x" });
		assert.deepEqual(
			await readRuntimeInfo(cwd, async () => { throw new Error("timeout"); }),
			{ name: "go" },
		);
	});

	it("caches by marker fingerprint, refreshes on marker change, and caps at 32 cwd entries", async () => {
		const cwd = project({ "package.json": "{}" });
		const calls: unknown[][] = [];
		const exec = executor(calls);
		await readRuntimeInfo(cwd, exec);
		await readRuntimeInfo(cwd, exec);
		assert.equal(calls.length, 1);
		writeFileSync(join(cwd, "package.json"), "{\"changed\":true}\n");
		await readRuntimeInfo(cwd, exec);
		assert.equal(calls.length, 2);
		writeFileSync(join(cwd, "index.ts"), "export const changed = true;\n");
		await readRuntimeInfo(cwd, exec);
		assert.equal(calls.length, 2, "ordinary source changes must not invalidate runtime version");

		for (let index = 0; index < 35; index++) {
			await readRuntimeInfo(project({ "package.json": String(index) }), exec);
		}
		assert.equal(runtimeInfoCacheSize(), 32);
	});

	it("does not run a version command when no marker exists", async () => {
		let calls = 0;
		assert.equal(await readRuntimeInfo(project(), async () => {
			calls += 1;
			return { code: 0, stdout: "", stderr: "" };
		}), undefined);
		assert.equal(calls, 0);
	});
});
