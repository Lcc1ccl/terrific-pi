import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
	ArtifactPathError,
	assertAllowlisted,
	assertRelativeArtifactPath,
	resolveDraftPath,
	resolveInsideOutputRoot,
} from "../lib/artifacts.ts";

describe("artifact paths", () => {
	test("accepts relative docsflow paths", () => {
		assert.equal(assertRelativeArtifactPath("00_Research.md"), "00_Research.md");
		assert.equal(assertAllowlisted("00_Research.md", ["00_Research.md", "00_Research.draft.md"]), "00_Research.md");
	});

	test("rejects absolute and traversal", () => {
		assert.throws(() => assertRelativeArtifactPath("/tmp/x.md"), ArtifactPathError);
		assert.throws(() => assertRelativeArtifactPath("../secret.md"), ArtifactPathError);
		assert.throws(() => assertAllowlisted("other.md", ["00_Research.md"]), ArtifactPathError);
	});

	test("draft rewrite", () => {
		assert.equal(resolveDraftPath("00_Research.md", false), "00_Research.md");
		assert.equal(resolveDraftPath("00_Research.md", true), "00_Research.draft.md");
	});

	test("rejects symlink escape", () => {
		const root = mkdtempSync(path.join(tmpdir(), "docsflow-"));
		const out = path.join(root, "docsflow");
		mkdirSync(out);
		writeFileSync(path.join(root, "secret.txt"), "nope");
		symlinkSync(path.join(root, "secret.txt"), path.join(out, "leak.md"));
		assert.throws(() => resolveInsideOutputRoot(out, "leak.md"), ArtifactPathError);
	});
});
