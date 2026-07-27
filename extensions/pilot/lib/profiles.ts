import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PilotExpectedAgent } from "./delegation.ts";

export type PilotProfileName = "pilot.planner" | "pilot.worker" | "pilot.reviewer";

const PROFILE_FILES: Record<PilotProfileName, string> = {
	"pilot.planner": "pilot-planner.md",
	"pilot.worker": "pilot-worker.md",
	"pilot.reviewer": "pilot-reviewer.md",
};

function profilesDirectory(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");
}

export function expectedPilotProfile(name: PilotProfileName): PilotExpectedAgent {
	const filePath = realpathSync.native(path.join(profilesDirectory(), PROFILE_FILES[name]));
	return {
		filePath,
		definitionHash: createHash("sha256").update(readFileSync(filePath, "utf8")).digest("hex"),
		source: "package",
		packageName: "pilot",
		requireNoOverride: true,
	};
}
