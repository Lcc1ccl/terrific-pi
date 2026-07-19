import { writeFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

import {
	DEFAULT_MODEL_REQUESTS,
	loadModelsCatalog,
	renderModelResolutionMarkdown,
	resolveAll,
} from "./model-resolution.ts";
import { packageRoot } from "./profiles.ts";

const modelsPath = process.env.PI_MODELS_JSON ?? path.join(homedir(), ".pi/agent/models.json");
const catalog = loadModelsCatalog(modelsPath);
const rows = resolveAll(DEFAULT_MODEL_REQUESTS, catalog);
const markdown = renderModelResolutionMarkdown(rows);
const outPath = path.join(packageRoot(), "docs-agents/MODEL_RESOLUTION.md");
writeFileSync(outPath, markdown, "utf8");
process.stdout.write(`${outPath}\n`);
for (const row of rows) {
	process.stdout.write(`${row.agent}: ${row.status} ${row.resolvedProvider}/${row.resolvedModelId} ${row.note ?? ""}\n`);
}
process.exitCode = rows.some((row) => row.status === "blocked") ? 2 : 0;
