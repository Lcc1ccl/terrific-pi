import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, test } from "node:test";

import {
	GitFinalizeError,
	finalizeGit,
	inspectStagedGit,
	type GitExec,
} from "../lib/git-finalize.ts";

const execFileAsync = promisify(execFile);

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo(): string {
	const cwd = mkdtempSync(join(tmpdir(), "aux-git-"));
	git(cwd, ["init", "-q"]);
	git(cwd, ["config", "user.name", "Aux Test"]);
	git(cwd, ["config", "user.email", "aux@example.invalid"]);
	writeFileSync(join(cwd, "file.txt"), "initial\n", "utf8");
	git(cwd, ["add", "file.txt"]);
	git(cwd, ["commit", "-qm", "chore: initial"]);
	return cwd;
}

function trackedExec(calls: string[][] = []): GitExec {
	return async (command, args, options) => {
		calls.push([command, ...args]);
		try {
			const result = await execFileAsync(command, args, { cwd: options.cwd, timeout: options.timeout, signal: options.signal, encoding: "utf8" });
			return { code: 0, stdout: result.stdout, stderr: result.stderr, killed: false };
		} catch (error) {
			const value = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
			return { code: typeof value.code === "number" ? value.code : 1, stdout: value.stdout ?? "", stderr: value.stderr ?? "", killed: value.killed ?? false };
		}
	};
}

const config = { confirm: true, allowHeadless: false, allowPush: true };

describe("staged Git inspection", () => {
	test("fingerprints exact staged blob identity, not only names and line counts", async () => {
		const cwd = repo();
		writeFileSync(join(cwd, "file.txt"), "first\n", "utf8");
		git(cwd, ["add", "file.txt"]);
		const first = await inspectStagedGit(trackedExec(), cwd);
		writeFileSync(join(cwd, "file.txt"), "other\n", "utf8");
		git(cwd, ["add", "file.txt"]);
		const second = await inspectStagedGit(trackedExec(), cwd);
		assert.notEqual(first.fingerprint, second.fingerprint);
		assert.equal(first.nameStatus, second.nameStatus);
		assert.equal(first.stat, second.stat);
	});
});

describe("finalizeGit", () => {
	test("does not call the model when nothing is staged", async () => {
		const cwd = repo();
		let generated = false;
		await assert.rejects(finalizeGit({
			exec: trackedExec(), cwd, config, push: false, hasUI: true,
			confirm: async () => true,
			generateSubject: async () => { generated = true; return "fix: unused"; },
		}), (error: unknown) => error instanceof GitFinalizeError && error.code === "no_staged_changes");
		assert.equal(generated, false);
	});

	test("cancellation leaves HEAD unchanged", async () => {
		const cwd = repo();
		const before = git(cwd, ["rev-parse", "HEAD"]);
		writeFileSync(join(cwd, "file.txt"), "changed\n", "utf8");
		git(cwd, ["add", "file.txt"]);
		await assert.rejects(finalizeGit({
			exec: trackedExec(), cwd, config, push: false, hasUI: true,
			confirm: async () => false,
			generateSubject: async () => "fix: change file",
		}), (error: unknown) => error instanceof GitFinalizeError && error.code === "cancelled");
		assert.equal(git(cwd, ["rev-parse", "HEAD"]), before);
	});

	test("rechecks the exact staged fingerprint before committing", async () => {
		const cwd = repo();
		writeFileSync(join(cwd, "file.txt"), "first\n", "utf8");
		git(cwd, ["add", "file.txt"]);
		await assert.rejects(finalizeGit({
			exec: trackedExec(), cwd, config, push: false, hasUI: true,
			confirm: async () => true,
			generateSubject: async () => {
				writeFileSync(join(cwd, "file.txt"), "other\n", "utf8");
				git(cwd, ["add", "file.txt"]);
				return "fix: change file";
			},
		}), (error: unknown) => error instanceof GitFinalizeError && error.code === "staged_changed");
	});

	test("commits staged changes with argument arrays and returns a terminating receipt", async () => {
		const cwd = repo();
		const calls: string[][] = [];
		writeFileSync(join(cwd, "file.txt"), "changed\n", "utf8");
		git(cwd, ["add", "file.txt"]);
		const result = await finalizeGit({
			exec: trackedExec(calls), cwd, config, push: false, hasUI: true,
			confirm: async (_title, message) => {
				assert.match(message, /fix: change file/);
				return true;
			},
			generateSubject: async (metadata) => {
				assert.match(metadata.nameStatus, /file\.txt/);
				assert.equal(Object.hasOwn(metadata, "rawDiff"), false);
				return "fix: change file";
			},
		});
		assert.equal(result.status, "committed");
		assert.equal(git(cwd, ["log", "-1", "--pretty=%s"]), "fix: change file");
		assert.ok(calls.some((call) => call[0] === "git" && call.includes("commit") && call.includes("fix: change file")));
		assert.ok(calls.every((call) => !call.includes("--force")));
	});

	test("rejects push without an existing upstream before committing", async () => {
		const cwd = repo();
		writeFileSync(join(cwd, "file.txt"), "changed\n", "utf8");
		git(cwd, ["add", "file.txt"]);
		await assert.rejects(finalizeGit({
			exec: trackedExec(), cwd, config, push: true, hasUI: true,
			confirm: async () => true,
			generateSubject: async () => "fix: change file",
		}), (error: unknown) => error instanceof GitFinalizeError && error.code === "no_upstream");
		assert.equal(git(cwd, ["log", "-1", "--pretty=%s"]), "chore: initial");
	});

	test("keeps a successful local commit when push fails", async () => {
		const cwd = repo();
		const remote = mkdtempSync(join(tmpdir(), "aux-remote-"));
		git(remote, ["init", "--bare", "-q"]);
		git(cwd, ["remote", "add", "origin", remote]);
		git(cwd, ["push", "-qu", "origin", "HEAD"]);
		writeFileSync(join(cwd, "file.txt"), "changed\n", "utf8");
		git(cwd, ["add", "file.txt"]);
		const result = await finalizeGit({
			exec: trackedExec(), cwd, config, push: true, hasUI: true,
			confirm: async () => true,
			generateSubject: async () => {
				rmSync(remote, { recursive: true, force: true });
				return "fix: change file";
			},
		});
		assert.equal(result.status, "partial");
		assert.equal(git(cwd, ["log", "-1", "--pretty=%s"]), "fix: change file");
		assert.ok(result.pushError);
	});

	test("denies headless execution by default", async () => {
		const cwd = repo();
		writeFileSync(join(cwd, "file.txt"), "changed\n", "utf8");
		git(cwd, ["add", "file.txt"]);
		await assert.rejects(finalizeGit({
			exec: trackedExec(), cwd, config, push: false, hasUI: false,
			confirm: async () => true,
			generateSubject: async () => "fix: change file",
		}), (error: unknown) => error instanceof GitFinalizeError && error.code === "headless_denied");
	});
});
