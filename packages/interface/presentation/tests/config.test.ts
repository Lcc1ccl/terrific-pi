import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	DEFAULT_PRESENTATION_CONFIG,
	loadPresentationConfig,
	updatePresentationConfig,
} from "../lib/config.ts";

test("presentation config defaults when absent and fails closed when corrupt", () => {
	const dir = mkdtempSync(join(tmpdir(), "presentation-config-"));
	const path = join(dir, "terrific.json");
	try {
		assert.deepEqual(loadPresentationConfig(dir), { config: DEFAULT_PRESENTATION_CONFIG });
		writeFileSync(path, "{ bad", "utf8");
		const loaded = loadPresentationConfig(dir);
		assert.equal(loaded.config.enabled, false);
		assert.match(loaded.error ?? "", /parse/i);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("presentation config enables the OMP profile, user messages, and compact tools by default", () => {
	const dir = mkdtempSync(join(tmpdir(), "presentation-config-tools-"));
	const path = join(dir, "terrific.json");
	try {
		assert.equal(loadPresentationConfig(dir).config.style, "omp");
		assert.equal(loadPresentationConfig(dir).config.userMessageBox, true);
		assert.equal(loadPresentationConfig(dir).config.compactTools, true);
		assert.equal(loadPresentationConfig(dir).config.maxExpandedArtifacts, 16);
		writeFileSync(path, JSON.stringify({ presentation: { style: "classic", userMessageBox: false, compactTools: false } }), "utf8");
		assert.equal(loadPresentationConfig(dir).config.style, "classic");
		assert.equal(loadPresentationConfig(dir).config.userMessageBox, false);
		assert.equal(loadPresentationConfig(dir).config.compactTools, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("presentation config updates only its own section atomically", () => {
	const dir = mkdtempSync(join(tmpdir(), "presentation-config-write-"));
	const path = join(dir, "terrific.json");
	try {
		writeFileSync(path, JSON.stringify({ fast: { enabled: true }, presentation: { maxExpandedArtifacts: 4 } }), "utf8");
		const result = updatePresentationConfig(dir, { enabled: false, artifacts: false });
		assert.equal(result.ok, true);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
			fast: { enabled: true },
			presentation: {
				maxExpandedArtifacts: 4,
				enabled: false,
				artifacts: false,
			},
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
