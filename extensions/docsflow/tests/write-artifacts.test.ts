import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { backupAndApplyDrafts, listDraftArtifacts, materializeArtifacts } from "../lib/write-artifacts.ts";

describe("write artifacts", () => {
	test("writes formal then draft", () => {
		const root = mkdtempSync(path.join(tmpdir(), "docsflow-w-"));
		const out = path.join(root, "docsflow");
		const first = materializeArtifacts({
			outputRoot: out,
			allowlist: ["00_Research.md", "00_Research.draft.md"],
			artifacts: [{ path: "00_Research.md", content: "v1" }],
		});
		assert.deepEqual(first.formal, ["00_Research.md"]);
		const second = materializeArtifacts({
			outputRoot: out,
			allowlist: ["00_Research.md", "00_Research.draft.md"],
			artifacts: [{ path: "00_Research.md", content: "v2" }],
		});
		assert.deepEqual(second.drafts, ["00_Research.draft.md"]);
		assert.equal(readFileSync(path.join(out, "00_Research.md"), "utf8"), "v1\n");
	});

	test("apply drafts", () => {
		const root = mkdtempSync(path.join(tmpdir(), "docsflow-a-"));
		const out = path.join(root, "docsflow");
		mkdirSync(out, { recursive: true });
		writeFileSync(path.join(out, "00_Research.md"), "old\n");
		writeFileSync(path.join(out, "00_Research.draft.md"), "new\n");
		const pairs = listDraftArtifacts(out);
		const result = backupAndApplyDrafts({
			outputRoot: out,
			backupRoot: path.join(root, "backups"),
			pairs,
			timestamp: "t",
		});
		assert.equal(readFileSync(path.join(out, "00_Research.md"), "utf8"), "new\n");
		assert.ok(existsSync(path.join(result.backupDir, "00_Research.md")));
	});
});
