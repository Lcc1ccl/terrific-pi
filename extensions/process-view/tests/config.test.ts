import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadProcessViewDefault, updateProcessViewConfig } from "../lib/config.ts";

describe("process-view global default", () => {
	it("defaults to compact and persists only processView.defaultViewMode", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "process-config-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, JSON.stringify({ fast: { enabled: true }, processView: { future: "keep" } }));
		assert.equal(loadProcessViewDefault(agentDir), "compact");
		const result = updateProcessViewConfig(agentDir, "off");
		assert.equal(result.ok, true);
		assert.equal(loadProcessViewDefault(agentDir), "off");
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
			fast: { enabled: true },
			processView: { future: "keep", defaultViewMode: "off" },
		});
	});

	it("refuses malformed config without overwriting it", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "process-config-bad-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, "{ bad");
		assert.equal(updateProcessViewConfig(agentDir, "full").ok, false);
		assert.equal(readFileSync(path, "utf8"), "{ bad");
	});
});
