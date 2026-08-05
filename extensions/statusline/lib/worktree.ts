export interface WorktreeInfo {
	branch?: string;
	oid?: string;
	detached: boolean;
	ahead: number;
	behind: number;
	stash: number;
	conflicted: number;
	renamed: number;
	deleted: number;
	staged: number;
	modified: number;
	untracked: number;
}

type Exec = (
	command: string,
	args: string[],
	options: { cwd: string; timeout: number },
) => Promise<{ code: number; stdout: string; stderr?: string }>;

export function parseWorktreeStatus(output: string): WorktreeInfo {
	const status: WorktreeInfo = {
		detached: false,
		ahead: 0,
		behind: 0,
		stash: 0,
		conflicted: 0,
		renamed: 0,
		deleted: 0,
		staged: 0,
		modified: 0,
		untracked: 0,
	};
	for (const line of output.split("\n")) {
		if (line.startsWith("# branch.oid ")) {
			const oid = line.slice(13).trim();
			if (oid !== "(initial)") status.oid = oid;
			continue;
		}
		if (line.startsWith("# branch.head ")) {
			const head = line.slice(14).trim();
			status.detached = head === "(detached)";
			status.branch = status.detached ? status.oid?.slice(0, 7) : head;
			continue;
		}
		if (line.startsWith("# branch.ab ")) {
			const match = line.match(/\+(\d+)\s+-(\d+)/);
			status.ahead = Number(match?.[1] ?? 0);
			status.behind = Number(match?.[2] ?? 0);
			continue;
		}
		if (line.startsWith("# stash ")) {
			status.stash = Number(line.slice(8).trim()) || 0;
			continue;
		}
		if (line.startsWith("? ")) {
			status.untracked += 1;
			continue;
		}
		if (line.startsWith("u ")) {
			const x = line[2];
			const y = line[3];
			status.conflicted += 1;
			if (x && x !== ".") status.staged += 1;
			if (y && y !== ".") status.modified += 1;
			continue;
		}
		if (!line.startsWith("1 ") && !line.startsWith("2 ")) continue;
		const xy = line.slice(2, 4);
		const x = xy[0];
		const y = xy[1];
		if (x === "U" || y === "U") status.conflicted += 1;
		if (x === "R" || y === "R") status.renamed += 1;
		if (x === "D" || y === "D") status.deleted += 1;
		if (x && x !== ".") status.staged += 1;
		if (y && y !== ".") status.modified += 1;
	}
	return status;
}

export async function readWorktreeInfo(exec: Exec, cwd: string): Promise<WorktreeInfo | undefined> {
	try {
		const result = await exec(
			"git",
			["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--show-stash"],
			{ cwd, timeout: 2_000 },
		);
		return result.code === 0 ? parseWorktreeStatus(result.stdout) : undefined;
	} catch {
		return undefined;
	}
}
