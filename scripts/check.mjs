import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const resources = [
	...(manifest.pi?.extensions ?? []),
	...(manifest.pi?.skills ?? []),
];
for (const resource of resources) {
	if (!existsSync(join(root, resource))) throw new Error(`missing package resource: ${resource}`);
}

const testsDir = join(root, "tests");
if (!existsSync(testsDir)) {
	console.log(`verified ${resources.length} packaged runtime resource paths`);
	process.exit(0);
}

for (const domain of ["interface", "session-control", "runtime"]) {
	const domainRoot = join(root, "packages", domain);
	for (const component of readdirSync(domainRoot).sort()) {
		const componentRoot = join(domainRoot, component);
		const componentManifest = JSON.parse(readFileSync(join(componentRoot, "package.json"), "utf8"));
		const script = componentManifest.scripts?.check ? "check" : "test";
		execFileSync("npm", ["--prefix", componentRoot, "run", script], { stdio: "inherit", env: process.env });
	}
}

const tests = readdirSync(testsDir)
	.filter((name) => name.endsWith(".test.ts"))
	.map((name) => join(testsDir, name));
execFileSync(process.execPath, ["--test", "--experimental-strip-types", ...tests], {
	stdio: "inherit",
	env: process.env,
});
