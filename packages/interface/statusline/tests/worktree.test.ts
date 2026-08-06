import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { parseWorktreeStatus, readWorktreeInfo } from "../lib/worktree.ts";

const execFileAsync = promisify(execFile);

const PORCELAIN = [
	"# branch.oid 1234567890abcdef",
	"# branch.head feature/demo",
	"# branch.upstream origin/feature/demo",
	"# branch.ab +2 -3",
	"# stash 4",
	"1 M. N... 100644 100644 100644 abc abc staged.txt",
	"1 .M N... 100644 100644 100644 abc abc modified.txt",
	"1 D. N... 100644 000000 000000 abc 000 deleted-staged.txt",
	"1 .D N... 100644 100644 000000 abc abc deleted-worktree.txt",
	"2 R. N... 100644 100644 100644 abc abc R100 renamed.txt\toriginal.txt",
	"u UU N... 100644 100644 100644 100644 abc abc abc conflict.txt",
	"? untracked.txt",
].join("\n");

describe("parseWorktreeStatus", () => {
	it("parses branch divergence stash and all requested change classes", () => {
		assert.deepEqual(parseWorktreeStatus(PORCELAIN), {
			branch: "feature/demo",
			oid: "1234567890abcdef",
			detached: false,
			ahead: 2,
			behind: 3,
			stash: 4,
			conflicted: 1,
			renamed: 1,
			deleted: 2,
			staged: 4,
			modified: 3,
			untracked: 1,
		});
	});

	it("counts R/D/U classifications in addition to independent index/worktree state", () => {
		const cases = [
			{ line: "2 R. N... 100644 100644 100644 abc abc R100 new\\told", expected: { renamed: 1, staged: 1, modified: 0, deleted: 0, conflicted: 0 } },
			{ line: "2 .R N... 100644 100644 100644 abc abc R100 new\\told", expected: { renamed: 1, staged: 0, modified: 1, deleted: 0, conflicted: 0 } },
			{ line: "1 D. N... 100644 000000 000000 abc 000 gone", expected: { renamed: 0, staged: 1, modified: 0, deleted: 1, conflicted: 0 } },
			{ line: "1 .D N... 100644 100644 000000 abc abc gone", expected: { renamed: 0, staged: 0, modified: 1, deleted: 1, conflicted: 0 } },
			{ line: "u UU N... 100644 100644 100644 100644 abc abc abc conflict", expected: { renamed: 0, staged: 1, modified: 1, deleted: 0, conflicted: 1 } },
		] as const;
		for (const { line, expected } of cases) {
			const parsed = parseWorktreeStatus(line);
			assert.deepEqual({
				renamed: parsed.renamed,
				staged: parsed.staged,
				modified: parsed.modified,
				deleted: parsed.deleted,
				conflicted: parsed.conflicted,
			}, expected, line);
		}
	});

	it("uses the short oid for detached HEAD", () => {
		const parsed = parseWorktreeStatus("# branch.oid abcdef1234567890\n# branch.head (detached)\n");
		assert.equal(parsed.detached, true);
		assert.equal(parsed.branch, "abcdef1");
	});
});

describe("readWorktreeInfo", () => {
	it("reads repository roots, subdirectories, and linked worktrees", async () => {
		const sandbox = mkdtempSync(join(tmpdir(), "statusline-worktree-"));
		const root = join(sandbox, "repo");
		const linked = join(sandbox, "linked");
		const runGit = async (args: string[], cwd = root) => {
			const { stdout, stderr } = await execFileAsync("git", args, { cwd });
			return { code: 0, stdout, stderr };
		};
		const injectedExec = async (command: string, args: string[], options: { cwd: string; timeout: number }) => {
			assert.equal(command, "git");
			const { stdout, stderr } = await execFileAsync(command, args, options);
			return { code: 0, stdout, stderr };
		};

		try {
			mkdirSync(root);
			await runGit(["init", "-b", "main"]);
			await runGit(["config", "user.email", "statusline@example.invalid"]);
			await runGit(["config", "user.name", "Statusline Test"]);
			writeFileSync(join(root, "tracked.txt"), "initial\n");
			await runGit(["add", "tracked.txt"]);
			await runGit(["commit", "-m", "initial"]);
			mkdirSync(join(root, "nested"));
			await runGit(["worktree", "add", "-b", "linked", linked]);

			assert.equal((await readWorktreeInfo(injectedExec, root))?.branch, "main");
			assert.equal((await readWorktreeInfo(injectedExec, join(root, "nested")))?.branch, "main");
			assert.equal((await readWorktreeInfo(injectedExec, linked))?.branch, "linked");
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});

	it("uses injected pi.exec once with porcelain v2 and a 2s timeout", async () => {
		const calls: unknown[][] = [];
		const exec = async (...args: unknown[]) => {
			calls.push(args);
			return { code: 0, stdout: PORCELAIN, stderr: "" };
		};
		const info = await readWorktreeInfo(exec, "/repo/subdir");
		assert.equal(info?.ahead, 2);
		assert.deepEqual(calls, [[
			"git",
			["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--show-stash"],
			{ cwd: "/repo/subdir", timeout: 2_000 },
		]]);
	});

	it("returns unavailable on command failure or exception", async () => {
		assert.equal(await readWorktreeInfo(async () => ({ code: 128, stdout: "", stderr: "no repo" }), "/tmp"), undefined);
		assert.equal(await readWorktreeInfo(async () => { throw new Error("timeout"); }, "/tmp"), undefined);
	});
});
