import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { mergeConfig, resolveConfigPaths, updateContextConfig } from "../lib/config.ts";

describe("resolveConfigPaths", () => {
	it("ignores project config when the project is not trusted", () => {
		assert.deepEqual(resolveConfigPaths("/workspace", "/agent", false, ".pi"), [
			"/agent/terrific.json",
		]);
	});

	it("uses the configured project directory name for trusted projects", () => {
		assert.deepEqual(resolveConfigPaths("/workspace", "/agent", true, ".custom-pi"), [
			"/agent/terrific.json",
			"/workspace/.custom-pi/terrific.json",
		]);
	});
});

describe("context config writer", () => {
	it("updates only context.topEntries and preserves sibling sections", () => {
		const root = mkdtempSync(join(tmpdir(), "context-config-"));
		const path = join(root, "terrific.json");
		writeFileSync(path, JSON.stringify({ fast: { enabled: true }, context: { future: "keep" } }));
		const result = updateContextConfig(path, (context) => { context.topEntries = 24; });
		assert.equal(result.ok, true);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
			fast: { enabled: true },
			context: { future: "keep", topEntries: 24 },
		});
	});

	it("does not overwrite malformed configuration", () => {
		const root = mkdtempSync(join(tmpdir(), "context-config-bad-"));
		const path = join(root, "terrific.json");
		writeFileSync(path, "{ bad");
		assert.equal(updateContextConfig(path, (context) => { context.topEntries = 20; }).ok, false);
		assert.equal(readFileSync(path, "utf8"), "{ bad");
	});
});

describe("mergeConfig", () => {
	it("bounds numeric settings", () => {
		const config = mergeConfig({
			context: { topEntries: Number.MAX_SAFE_INTEGER },
			btw: {
				maxContextTokens: Number.MAX_SAFE_INTEGER,
				maxOutputTokens: Number.MAX_SAFE_INTEGER,
			},
		});

		assert.ok(config.context.topEntries <= 100);
		assert.ok(config.btw.maxContextTokens <= 1_000_000);
		assert.ok(config.btw.maxOutputTokens <= 100_000);
	});
});
