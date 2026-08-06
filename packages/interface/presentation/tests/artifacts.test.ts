import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	ArtifactJournal,
	captureGitSnapshot,
	diffLineStats,
	reconcileGitSnapshots,
	sanitizeArtifactPath,
	type GitSnapshot,
} from "../lib/artifacts.ts";

function initGitWorkspace(prefix: string) {
	const workspace = mkdtempSync(join(tmpdir(), prefix));
	const git = (args: string[]) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
	git(["init", "-q"]);
	git(["config", "user.name", "Presentation Test"]);
	git(["config", "user.email", "presentation@example.invalid"]);
	return { workspace, git };
}

function gitRunner(cwd: string) {
	return async (args: string[]) => {
		try {
			return { code: 0, stdout: execFileSync("git", args, { cwd, encoding: "utf8" }) };
		} catch (error) {
			const value = error as { status?: number; stdout?: string };
			return { code: value.status ?? 1, stdout: value.stdout ?? "" };
		}
	};
}

test("artifact paths stay workspace-relative and external paths collapse to basename", () => {
	assert.deepEqual(sanitizeArtifactPath("src/app.ts", "/workspace/project"), {
		path: "src/app.ts",
		insideWorkspace: true,
		absolutePath: "/workspace/project/src/app.ts",
	});
	assert.deepEqual(sanitizeArtifactPath("/private/secret.env", "/workspace/project"), {
		path: "secret.env",
		insideWorkspace: false,
	});
});

test("artifact paths remove terminal control sequences before storage", () => {
	const safe = sanitizeArtifactPath("src/evil\n\u001b[31mred\u001b[0m.ts", "/workspace/project");
	assert.equal(safe.insideWorkspace, true);
	assert.doesNotMatch(safe.path, /[\x00-\x1f\x7f-\x9f]/);
	assert.doesNotMatch(safe.path, /\u001b/);
});

test("line diff stats are exact for a bounded text write", () => {
	assert.deepEqual(diffLineStats("one\ntwo\nthree\n", "one\nTWO\nthree\nfour\n"), {
		additions: 2,
		deletions: 1,
	});
});

test("journal does not emit a file state for a failed write with no side effect", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "presentation-failed-write-"));
	try {
		const journal = new ArtifactJournal();
		await journal.begin(workspace, undefined, "request-1");
		await journal.startTool("write-1", "write", { path: "src/fail.ts", content: "nope" });
		journal.endTool("write-1", "write", { content: [{ type: "text", text: "failed" }] }, true);
		assert.equal(await journal.snapshot(1, [{ toolCallId: "write-1", toolName: "write" }]), undefined);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("git reconciliation marks changed pre-existing files without inventing diff stats", () => {
	const before: GitSnapshot = {
		files: new Map([["src/dirty.ts", { path: "src/dirty.ts", operation: "modified", fingerprint: "old" }]]),
	};
	const after: GitSnapshot = {
		files: new Map([["src/dirty.ts", { path: "src/dirty.ts", operation: "modified", fingerprint: "new" }]]),
	};
	assert.deepEqual(reconcileGitSnapshots(before, after, new Set()), [{
		path: "src/dirty.ts",
		operation: "modified",
		sources: ["git"],
		preExisting: true,
	}]);
});

test("git status disappearance alone is not reported as a file mutation", () => {
	const before: GitSnapshot = {
		files: new Map([
			["scratch.txt", { path: "scratch.txt", operation: "added", fingerprint: "scratch" }],
			["src/dirty.ts", { path: "src/dirty.ts", operation: "modified", fingerprint: "dirty" }],
		]),
	};
	assert.deepEqual(reconcileGitSnapshots(before, { files: new Map() }, new Set(), new Set(["scratch.txt", "src/dirty.ts"])), []);
});

test("request-created files are not marked pre-existing", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "presentation-new-file-"));
	try {
		const journal = new ArtifactJournal();
		await journal.begin(workspace, { files: new Map() }, "request-1");
		await journal.startTool("write-1", "write", { path: "new.ts", content: "second" });
		writeFileSync(join(workspace, "new.ts"), "second", "utf8");
		journal.endTool("write-1", "write", { content: [] }, false);
		const receipt = await journal.snapshot(1, [{ toolCallId: "write-1", toolName: "write" }]);
		assert.equal(receipt?.files.find((file) => file.path === "new.ts")?.preExisting, undefined);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("git snapshots request every untracked file rather than a directory placeholder", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "presentation-git-untracked-"));
	try {
		writeFileSync(join(workspace, "a.txt"), "a");
		writeFileSync(join(workspace, "b.txt"), "b");
		let statusArgs: string[] | undefined;
		const snapshot = await captureGitSnapshot(async (args) => {
			if (args[0] === "status") {
				statusArgs = args;
				return { code: 0, stdout: "? a.txt\0? b.txt\0" };
			}
			return { code: 0, stdout: "" };
		}, workspace);
		assert.deepEqual(statusArgs, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
		assert.deepEqual([...snapshot!.files.keys()], ["a.txt", "b.txt"]);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("git reconciliation detects large binary content changes", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "presentation-git-binary-"));
	const path = join(workspace, "asset.bin");
	const runGit = async (args: string[]) => args[0] === "status"
		? { code: 0, stdout: "? asset.bin\0" }
		: { code: 0, stdout: "" };
	try {
		const first = Buffer.alloc(256 * 1024 + 1, 0x61);
		first[0] = 0;
		writeFileSync(path, first);
		const before = await captureGitSnapshot(runGit, workspace);
		first[first.length - 1] = 0x62;
		writeFileSync(path, first);
		const after = await captureGitSnapshot(runGit, workspace);
		assert.deepEqual(reconcileGitSnapshots(before!, after!, new Set(), new Set()), [{
			path: "asset.bin",
			operation: "added",
			sources: ["git"],
		}]);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("request artifact revisions publish one net snapshot across tool turns", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "presentation-request-artifacts-"));
	const path = join(workspace, "src.ts");
	try {
		writeFileSync(path, "one\ntwo\n", "utf8");
		const journal = new ArtifactJournal();
		await journal.begin(workspace, undefined, "request-1");

		await journal.startTool("edit-1", "edit", { path: "src.ts" });
		writeFileSync(path, "one\nTWO\n", "utf8");
		journal.endTool("edit-1", "edit", { content: [], details: { diff: "-1 two\n+1 TWO" } }, false);
		const first = await journal.snapshot(1, [{ toolCallId: "edit-1", toolName: "edit" }]);
		assert.deepEqual(first?.files, [{
			path: "src.ts",
			operation: "modified",
			additions: 1,
			deletions: 1,
			sources: ["edit"],
		}]);
		assert.equal(first?.requestId, "request-1");
		assert.equal(first?.revision, 1);
		assert.equal(first?.anchorToolCallId, "edit-1");

		await journal.startTool("write-1", "write", { path: "src.ts", content: "one\nTWO\nthree\n" });
		writeFileSync(path, "one\nTWO\nthree\n", "utf8");
		journal.endTool("write-1", "write", { content: [] }, false);
		const second = await journal.snapshot(2, [{ toolCallId: "write-1", toolName: "write" }]);
		assert.deepEqual(second?.files, [{
			path: "src.ts",
			operation: "modified",
			additions: 2,
			deletions: 1,
			sources: ["edit", "write"],
		}]);
		assert.equal(second?.revision, 2);
		assert.equal(second?.supersedes, first?.receiptId);
		assert.equal(second?.anchorToolCallId, "write-1");

		await journal.startTool("edit-2", "edit", { path: "src.ts" });
		writeFileSync(path, "one\ntwo\n", "utf8");
		journal.endTool("edit-2", "edit", { content: [] }, false);
		const reverted = await journal.snapshot(3, [{ toolCallId: "edit-2", toolName: "edit" }]);
		assert.deepEqual(reverted?.files, []);
		assert.equal(reverted?.reverted, true);
		assert.equal(reverted?.anchorToolCallId, "edit-2");
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("a pre-existing dirty file becoming clean through commit does not create a false artifact", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "presentation-git-commit-"));
	const git = (args: string[]) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
	const runGit = async (args: string[]) => {
		try {
			return { code: 0, stdout: git(args) };
		} catch (error) {
			const value = error as { status?: number; stdout?: string };
			return { code: value.status ?? 1, stdout: value.stdout ?? "" };
		}
	};
	try {
		git(["init", "-q"]);
		git(["config", "user.name", "Presentation Test"]);
		git(["config", "user.email", "presentation@example.invalid"]);
		writeFileSync(join(workspace, "app.ts"), "one\n", "utf8");
		git(["add", "app.ts"]);
		git(["commit", "-qm", "chore: initial"]);
		writeFileSync(join(workspace, "app.ts"), "two\n", "utf8");
		const before = await captureGitSnapshot(runGit, workspace);
		const journal = new ArtifactJournal();
		await journal.begin(workspace, before, "request-1");
		git(["add", "app.ts"]);
		git(["commit", "-qm", "chore: pre-existing"]);
		const after = await captureGitSnapshot(runGit, workspace, journal.baseHead());
		assert.equal(await journal.snapshot(1, [{ toolCallId: "bash-1", toolName: "bash" }], after), undefined);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("staged text and binary content changes remain visible", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "presentation-git-staged-content-"));
	const git = (args: string[]) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
	const runGit = async (args: string[]) => {
		try {
			return { code: 0, stdout: git(args) };
		} catch (error) {
			const value = error as { status?: number; stdout?: string };
			return { code: value.status ?? 1, stdout: value.stdout ?? "" };
		}
	};
	try {
		git(["init", "-q"]);
		git(["config", "user.name", "Presentation Test"]);
		git(["config", "user.email", "presentation@example.invalid"]);
		writeFileSync(join(workspace, "app.ts"), "one\n", "utf8");
		writeFileSync(join(workspace, "asset.bin"), Buffer.from([0, 2, 3]));
		git(["add", "app.ts", "asset.bin"]);
		git(["commit", "-qm", "chore: initial"]);
		const before = await captureGitSnapshot(runGit, workspace);
		const journal = new ArtifactJournal();
		await journal.begin(workspace, before, "request-1");
		writeFileSync(join(workspace, "app.ts"), "two\n", "utf8");
		writeFileSync(join(workspace, "asset.bin"), Buffer.from([0, 8, 7]));
		git(["add", "app.ts", "asset.bin"]);
		const after = await captureGitSnapshot(runGit, workspace, journal.baseHead());
		const receipt = await journal.snapshot(1, [{ toolCallId: "bash-1", toolName: "bash" }], after);
		assert.deepEqual(receipt?.files.find((file) => file.path === "app.ts"), {
			path: "app.ts",
			operation: "modified",
			additions: 1,
			deletions: 1,
			sources: ["git"],
		});
		assert.deepEqual(receipt?.files.find((file) => file.path === "asset.bin"), {
			path: "asset.bin",
			operation: "modified",
			sources: ["git"],
		});
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("a staged rename preserves deleted and added artifact sides", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "presentation-git-rename-"));
	const git = (args: string[]) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
	const runGit = async (args: string[]) => {
		try {
			return { code: 0, stdout: git(args) };
		} catch (error) {
			const value = error as { status?: number; stdout?: string };
			return { code: value.status ?? 1, stdout: value.stdout ?? "" };
		}
	};
	try {
		git(["init", "-q"]);
		git(["config", "user.name", "Presentation Test"]);
		git(["config", "user.email", "presentation@example.invalid"]);
		writeFileSync(join(workspace, "app.ts"), "one\n", "utf8");
		git(["add", "app.ts"]);
		git(["commit", "-qm", "chore: initial"]);
		const before = await captureGitSnapshot(runGit, workspace);
		const journal = new ArtifactJournal();
		await journal.begin(workspace, before, "request-1");
		git(["mv", "app.ts", "renamed.ts"]);
		const after = await captureGitSnapshot(runGit, workspace, journal.baseHead());
		const receipt = await journal.snapshot(1, [{ toolCallId: "bash-1", toolName: "bash" }], after);
		assert.deepEqual(receipt?.files, [
			{ path: "app.ts", operation: "deleted", sources: ["git"] },
			{ path: "renamed.ts", operation: "added", sources: ["git"] },
		]);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("a staged rename with content edits keeps target line statistics", async () => {
	const { workspace, git } = initGitWorkspace("presentation-git-rename-stats-");
	try {
		writeFileSync(join(workspace, "app.ts"), "one\n", "utf8");
		git(["add", "app.ts"]);
		git(["commit", "-qm", "chore: initial"]);
		const runGit = gitRunner(workspace);
		const before = await captureGitSnapshot(runGit, workspace);
		const journal = new ArtifactJournal();
		await journal.begin(workspace, before, "request-1");
		git(["mv", "app.ts", "renamed.ts"]);
		writeFileSync(join(workspace, "renamed.ts"), "one\ntwo\n", "utf8");
		git(["add", "renamed.ts"]);
		const after = await captureGitSnapshot(runGit, workspace, journal.baseHead());
		const receipt = await journal.snapshot(1, [{ toolCallId: "bash-1", toolName: "bash" }], after);
		assert.deepEqual(receipt?.files.find((file) => file.path === "renamed.ts"), {
			path: "renamed.ts",
			operation: "added",
			additions: 1,
			deletions: 0,
			sources: ["git"],
		});
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("a committed rename from outside a workspace subdirectory retains the added side", async () => {
	const { workspace, git } = initGitWorkspace("presentation-git-cross-boundary-rename-");
	const cwd = join(workspace, "sub");
	try {
		mkdirSync(cwd);
		writeFileSync(join(workspace, "outside.txt"), "one\n", "utf8");
		git(["add", "outside.txt"]);
		git(["commit", "-qm", "chore: initial"]);
		const runGit = gitRunner(cwd);
		const before = await captureGitSnapshot(runGit, cwd);
		const journal = new ArtifactJournal();
		await journal.begin(cwd, before, "request-1");
		git(["mv", "outside.txt", "sub/inside.txt"]);
		git(["commit", "-qm", "chore: move into workspace"]);
		const after = await captureGitSnapshot(runGit, cwd, journal.baseHead());
		const receipt = await journal.snapshot(1, [{ toolCallId: "bash-1", toolName: "bash" }], after);
		assert.deepEqual(receipt?.files.map(({ path, operation }) => ({ path, operation })), [
			{ path: "inside.txt", operation: "added" },
		]);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("a staged rename from a workspace subdirectory retains the deleted side", async () => {
	const { workspace, git } = initGitWorkspace("presentation-git-cross-boundary-delete-");
	const cwd = join(workspace, "sub");
	try {
		mkdirSync(cwd);
		writeFileSync(join(cwd, "inside.txt"), "one\n", "utf8");
		git(["add", "sub/inside.txt"]);
		git(["commit", "-qm", "chore: initial"]);
		const runGit = gitRunner(cwd);
		const before = await captureGitSnapshot(runGit, cwd);
		const journal = new ArtifactJournal();
		await journal.begin(cwd, before, "request-1");
		git(["mv", "sub/inside.txt", "outside.txt"]);
		const after = await captureGitSnapshot(runGit, cwd, journal.baseHead());
		const receipt = await journal.snapshot(1, [{ toolCallId: "bash-1", toolName: "bash" }], after);
		assert.deepEqual(receipt?.files.map(({ path, operation }) => ({ path, operation })), [
			{ path: "inside.txt", operation: "deleted" },
		]);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("a committed copy from outside a workspace subdirectory retains only the added target", async () => {
	const { workspace, git } = initGitWorkspace("presentation-git-cross-boundary-copy-");
	const cwd = join(workspace, "sub");
	try {
		mkdirSync(cwd);
		git(["config", "diff.renames", "copies"]);
		writeFileSync(join(workspace, "outside.txt"), "one\ntwo\n", "utf8");
		git(["add", "outside.txt"]);
		git(["commit", "-qm", "chore: initial"]);
		const runGit = gitRunner(cwd);
		const before = await captureGitSnapshot(runGit, cwd);
		const journal = new ArtifactJournal();
		await journal.begin(cwd, before, "request-1");
		writeFileSync(join(cwd, "inside.txt"), "one\ntwo\n", "utf8");
		writeFileSync(join(workspace, "outside.txt"), "one\ntwo\nthree\n", "utf8");
		git(["add", "outside.txt", "sub/inside.txt"]);
		git(["commit", "-qm", "chore: copy into workspace"]);
		const after = await captureGitSnapshot(runGit, cwd, journal.baseHead());
		const receipt = await journal.snapshot(1, [{ toolCallId: "bash-1", toolName: "bash" }], after);
		assert.deepEqual(receipt?.files.map(({ path, operation }) => ({ path, operation })), [
			{ path: "inside.txt", operation: "added" },
		]);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("unmerged worktree content remains visible as a Git artifact", async () => {
	const { workspace, git } = initGitWorkspace("presentation-git-unmerged-");
	try {
		writeFileSync(join(workspace, "app.txt"), "base\n", "utf8");
		git(["add", "app.txt"]);
		git(["commit", "-qm", "chore: initial"]);
		const main = git(["branch", "--show-current"]).trim();
		git(["checkout", "-qb", "feature"]);
		writeFileSync(join(workspace, "app.txt"), "feature\n", "utf8");
		git(["commit", "-qam", "feat: feature change"]);
		git(["checkout", "-q", main]);
		writeFileSync(join(workspace, "app.txt"), "main\n", "utf8");
		git(["commit", "-qam", "feat: main change"]);
		const runGit = gitRunner(workspace);
		const before = await captureGitSnapshot(runGit, workspace);
		const journal = new ArtifactJournal();
		await journal.begin(workspace, before, "request-1");
		assert.throws(() => git(["merge", "feature"]));
		const after = await captureGitSnapshot(runGit, workspace, journal.baseHead());
		const receipt = await journal.snapshot(1, [{ toolCallId: "bash-1", toolName: "bash" }], after);
		assert.deepEqual(receipt?.files.map(({ path, operation }) => ({ path, operation })), [
			{ path: "app.txt", operation: "modified" },
		]);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Git tracks a workspace symlink without following its external target", async () => {
	const { workspace, git } = initGitWorkspace("presentation-git-external-symlink-");
	try {
		writeFileSync(join(workspace, "base.txt"), "base\n", "utf8");
		git(["add", "base.txt"]);
		git(["commit", "-qm", "chore: initial"]);
		const runGit = gitRunner(workspace);
		const before = await captureGitSnapshot(runGit, workspace);
		const journal = new ArtifactJournal();
		await journal.begin(workspace, before, "request-1");
		symlinkSync("/etc/hosts", join(workspace, "external-link"));
		git(["add", "external-link"]);
		const after = await captureGitSnapshot(runGit, workspace, journal.baseHead());
		const receipt = await journal.snapshot(1, [{ toolCallId: "bash-1", toolName: "bash" }], after);
		assert.deepEqual(receipt?.files.map(({ path, operation }) => ({ path, operation })), [
			{ path: "external-link", operation: "added" },
		]);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("an explicit mutation remains the artifact anchor when a read follows in the same turn", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "presentation-artifact-anchor-"));
	try {
		writeFileSync(join(workspace, "app.ts"), "one\n", "utf8");
		const journal = new ArtifactJournal();
		await journal.begin(workspace, undefined, "request-1");
		await journal.startTool("edit-1", "edit", { path: "app.ts" });
		writeFileSync(join(workspace, "app.ts"), "two\n", "utf8");
		journal.endTool("edit-1", "edit", { content: [] }, false);
		const receipt = await journal.snapshot(1, [
			{ toolCallId: "edit-1", toolName: "edit" },
			{ toolCallId: "read-1", toolName: "read" },
		]);
		assert.equal(receipt?.anchorToolCallId, "edit-1");
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("a successful explicit mutation stays the anchor when a later Bash call has no file effect", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "presentation-bash-artifact-anchor-"));
	try {
		writeFileSync(join(workspace, "app.ts"), "one\n", "utf8");
		const journal = new ArtifactJournal();
		await journal.begin(workspace, undefined, "request-1");
		await journal.startTool("edit-1", "edit", { path: "app.ts" });
		writeFileSync(join(workspace, "app.ts"), "two\n", "utf8");
		journal.endTool("edit-1", "edit", { content: [] }, false);
		await journal.startTool("bash-1", "bash", { command: "printf ok" });
		const receipt = await journal.snapshot(1, [
			{ toolCallId: "edit-1", toolName: "edit" },
			{ toolCallId: "bash-1", toolName: "bash" },
		]);
		assert.equal(receipt?.anchorToolCallId, "edit-1");
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("a later custom tool anchors a new net revision when no explicit mutation ran in its turn", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "presentation-custom-artifact-anchor-"));
	try {
		writeFileSync(join(workspace, "app.ts"), "one\n", "utf8");
		const journal = new ArtifactJournal();
		await journal.begin(workspace, undefined, "request-1");
		await journal.startTool("edit-1", "edit", { path: "app.ts" });
		writeFileSync(join(workspace, "app.ts"), "two\n", "utf8");
		journal.endTool("edit-1", "edit", { content: [] }, false);
		await journal.snapshot(1, [{ toolCallId: "edit-1", toolName: "edit" }]);
		writeFileSync(join(workspace, "app.ts"), "three\n", "utf8");
		const receipt = await journal.snapshot(2, [{ toolCallId: "custom-1", toolName: "custom_mutator" }]);
		assert.equal(receipt?.anchorToolCallId, "custom-1");
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("an index-only file mode change does not create a content artifact", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "presentation-git-index-only-"));
	const git = (args: string[]) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
	const runGit = async (args: string[]) => {
		try {
			return { code: 0, stdout: git(args) };
		} catch (error) {
			const value = error as { status?: number; stdout?: string };
			return { code: value.status ?? 1, stdout: value.stdout ?? "" };
		}
	};
	try {
		git(["init", "-q"]);
		git(["config", "user.name", "Presentation Test"]);
		git(["config", "user.email", "presentation@example.invalid"]);
		writeFileSync(join(workspace, "app.ts"), "one\n", "utf8");
		git(["add", "app.ts"]);
		git(["commit", "-qm", "chore: initial"]);
		const before = await captureGitSnapshot(runGit, workspace);
		const journal = new ArtifactJournal();
		await journal.begin(workspace, before, "request-1");
		git(["update-index", "--chmod=+x", "app.ts"]);
		const after = await captureGitSnapshot(runGit, workspace, journal.baseHead());
		assert.equal(await journal.snapshot(1, [{ toolCallId: "bash-1", toolName: "bash" }], after), undefined);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("a request mutation committed by Bash is retained through a clean final Git status", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "presentation-git-request-commit-"));
	const git = (args: string[]) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
	const runGit = async (args: string[]) => {
		try {
			return { code: 0, stdout: git(args) };
		} catch (error) {
			const value = error as { status?: number; stdout?: string };
			return { code: value.status ?? 1, stdout: value.stdout ?? "" };
		}
	};
	try {
		git(["init", "-q"]);
		git(["config", "user.name", "Presentation Test"]);
		git(["config", "user.email", "presentation@example.invalid"]);
		writeFileSync(join(workspace, "app.ts"), "one\n", "utf8");
		git(["add", "app.ts"]);
		git(["commit", "-qm", "chore: initial"]);
		const before = await captureGitSnapshot(runGit, workspace);
		const journal = new ArtifactJournal();
		await journal.begin(workspace, before, "request-1");
		writeFileSync(join(workspace, "app.ts"), "two\n", "utf8");
		git(["add", "app.ts"]);
		git(["commit", "-qm", "feat: request change"]);
		const after = await captureGitSnapshot(runGit, workspace, journal.baseHead());
		const receipt = await journal.snapshot(1, [{ toolCallId: "bash-1", toolName: "bash" }], after);
		assert.deepEqual(receipt?.files, [{
			path: "app.ts",
			operation: "modified",
			additions: 1,
			deletions: 1,
			sources: ["git"],
		}]);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("a committed Bash change plus pending work reports the net diff from the request base", async () => {
	const { workspace, git } = initGitWorkspace("presentation-git-commit-pending-");
	try {
		writeFileSync(join(workspace, "app.ts"), "base\n", "utf8");
		git(["add", "app.ts"]);
		git(["commit", "-qm", "chore: initial"]);
		const runGit = gitRunner(workspace);
		const before = await captureGitSnapshot(runGit, workspace);
		const journal = new ArtifactJournal();
		await journal.begin(workspace, before, "request-1");
		writeFileSync(join(workspace, "app.ts"), "base\ncommitted\n", "utf8");
		git(["add", "app.ts"]);
		git(["commit", "-qm", "feat: committed change"]);
		writeFileSync(join(workspace, "app.ts"), "base\ncommitted\npending\n", "utf8");
		const after = await captureGitSnapshot(runGit, workspace, journal.baseHead());
		const receipt = await journal.snapshot(1, [{ toolCallId: "bash-1", toolName: "bash" }], after);
		assert.deepEqual(receipt?.files, [{
			path: "app.ts",
			operation: "modified",
			additions: 2,
			deletions: 0,
			sources: ["git"],
		}]);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("a file added by a request commit then removed from the worktree has no net artifact", async () => {
	const { workspace, git } = initGitWorkspace("presentation-git-commit-revert-");
	try {
		writeFileSync(join(workspace, "base.txt"), "base\n", "utf8");
		git(["add", "base.txt"]);
		git(["commit", "-qm", "chore: initial"]);
		const runGit = gitRunner(workspace);
		const before = await captureGitSnapshot(runGit, workspace);
		const journal = new ArtifactJournal();
		await journal.begin(workspace, before, "request-1");
		writeFileSync(join(workspace, "temporary.ts"), "temporary\n", "utf8");
		git(["add", "temporary.ts"]);
		git(["commit", "-qm", "feat: temporary file"]);
		unlinkSync(join(workspace, "temporary.ts"));
		const after = await captureGitSnapshot(runGit, workspace, journal.baseHead());
		const receipt = await journal.snapshot(1, [{ toolCallId: "bash-1", toolName: "bash" }], after);
		assert.equal(receipt, undefined);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("git snapshots resolve repository-root paths from a workspace subdirectory", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "presentation-git-subdir-"));
	const subdirectory = join(workspace, "sub");
	const cwd = join(workspace, "workspace-link");
	const git = (args: string[]) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
	const runGit = async (args: string[]) => {
		try {
			return { code: 0, stdout: execFileSync("git", args, { cwd, encoding: "utf8" }) };
		} catch (error) {
			const value = error as { status?: number; stdout?: string };
			return { code: value.status ?? 1, stdout: value.stdout ?? "" };
		}
	};
	try {
		git(["init", "-q"]);
		git(["config", "user.name", "Presentation Test"]);
		git(["config", "user.email", "presentation@example.invalid"]);
		mkdirSync(subdirectory);
		symlinkSync("sub", cwd);
		writeFileSync(join(cwd, "app.ts"), "one\n", "utf8");
		git(["add", "sub/app.ts"]);
		git(["commit", "-qm", "chore: initial"]);
		writeFileSync(join(cwd, "app.ts"), "two\n", "utf8");
		const before = await captureGitSnapshot(runGit, cwd);
		const journal = new ArtifactJournal();
		await journal.begin(cwd, before, "request-1");
		writeFileSync(join(cwd, "app.ts"), "three\n", "utf8");
		git(["add", "sub/app.ts"]);
		const after = await captureGitSnapshot(runGit, cwd, journal.baseHead());
		const receipt = await journal.snapshot(1, [{ toolCallId: "bash-1", toolName: "bash" }], after);
		assert.deepEqual(receipt?.files, [{
			path: "app.ts",
			operation: "modified",
			additions: 1,
			deletions: 1,
			sources: ["git"],
			preExisting: true,
		}]);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("git snapshots retain a workspace symlink path and detect target changes", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "presentation-git-symlink-"));
	const runGit = async (args: string[]) => args[0] === "status"
		? { code: 0, stdout: "? link\0" }
		: { code: 0, stdout: "" };
	try {
		writeFileSync(join(workspace, "one.txt"), "one");
		writeFileSync(join(workspace, "two.txt"), "two");
		symlinkSync("one.txt", join(workspace, "link"));
		const before = await captureGitSnapshot(runGit, workspace);
		rmSync(join(workspace, "link"));
		symlinkSync("two.txt", join(workspace, "link"));
		const after = await captureGitSnapshot(runGit, workspace);
		assert.ok(before!.files.has("link"));
		assert.deepEqual(reconcileGitSnapshots(before!, after!, new Set(), new Set()), [{
			path: "link",
			operation: "added",
			sources: ["git"],
		}]);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});
