import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { patchModelProfileSection } from "../lib/config-write.ts";

describe("patchModelProfileSection", () => {
	it("creates modelProfile.startup when file missing", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-terrific-"));
		const result = patchModelProfileSection({ startup: true }, agentDir);
		assert.equal(result.ok, true);
		const json = JSON.parse(readFileSync(join(agentDir, "terrific.json"), "utf8")) as {
			modelProfile: { startup: boolean };
		};
		assert.equal(json.modelProfile.startup, true);
	});

	it("preserves profiles and sibling keys", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-terrific-keep-"));
		writeFileSync(
			join(agentDir, "terrific.json"),
			JSON.stringify({
				mode: { default: "edit" },
				modelProfile: {
					startup: false,
					startupScope: "session",
					profiles: [{ id: 1, alias: "default", provider: "grok", model: "g", thinking: "high" }],
				},
			}),
		);

		const result = patchModelProfileSection({ startup: true, startupScope: "global" }, agentDir);
		assert.equal(result.ok, true);
		const json = JSON.parse(readFileSync(join(agentDir, "terrific.json"), "utf8")) as {
			mode: { default: string };
			modelProfile: {
				startup: boolean;
				startupScope: string;
				profiles: Array<{ id: string }>;
			};
		};
		assert.equal(json.mode.default, "edit");
		assert.equal(json.modelProfile.startup, true);
		assert.equal(json.modelProfile.startupScope, "global");
		assert.equal(json.modelProfile.profiles[0]?.id, 1);
	});
});
