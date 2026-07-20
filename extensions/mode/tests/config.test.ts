import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mergeConfig, resolveConfigPaths } from "../lib/config.ts";

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
