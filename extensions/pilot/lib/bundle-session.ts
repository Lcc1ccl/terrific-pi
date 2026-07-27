import { realpathSync } from "node:fs";
import path from "node:path";

import { openPilotBundle, resolvePilotRunsRoot, type PilotBundle } from "./bundle.ts";

export const PILOT_BUNDLE_ENTRY_TYPE = "terrific-pi:pilot:bundle-v1";

export function toPilotBundleEntry(bundle: PilotBundle): { version: 1; bundleDir: string } {
	return { version: 1, bundleDir: bundle.dir };
}

export function restorePilotBundle(entries: unknown[], context: { cwd: string; gitCommonDir: string }): PilotBundle | undefined {
	const cwd = realpathSync.native(context.cwd);
	const runsRoot = resolvePilotRunsRoot(context.gitCommonDir);
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry || typeof entry !== "object") continue;
		const custom = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (custom.type !== "custom" || custom.customType !== PILOT_BUNDLE_ENTRY_TYPE || !custom.data || typeof custom.data !== "object") continue;
		const data = custom.data as { version?: unknown; bundleDir?: unknown };
		if (data.version !== 1 || typeof data.bundleDir !== "string" || !data.bundleDir) continue;
		try {
			const bundle = openPilotBundle(data.bundleDir);
			if (bundle.manifest.cwd !== cwd
				|| path.dirname(bundle.dir) !== runsRoot
				|| path.basename(bundle.dir) !== bundle.manifest.runId) continue;
			return bundle;
		} catch {
			// A stale session pointer is not a source of truth. Continue scanning older entries.
		}
	}
	return undefined;
}
