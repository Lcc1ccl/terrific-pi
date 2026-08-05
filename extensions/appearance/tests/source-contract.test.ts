import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function productionSources(dir: string): string[] {
  const result: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) result.push(...productionSources(path));
    else if (path.endsWith(".ts")) result.push(path);
  }
  return result;
}

test("manifest is installable with real extension path, wildcard peers, and zero runtime deps", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.type, "module");
  assert.equal(Object.hasOwn(manifest, "terrificPi"), false);
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(manifest.peerDependencies, {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
  });
  for (const entry of manifest.pi.extensions) assert.equal(existsSync(join(root, entry)), true, entry);
});

test("production source avoids forbidden owners, patches, output, clearing, timers, and force mode", () => {
  const files = productionSources(join(root, "extensions")).concat(productionSources(join(root, "lib")));
  const forbidden = ["setFooter", "setStatus", ".prototype", "process.stdout", "setInterval", "setTimeout", "clearVisibleScreen", "force:"];
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    for (const token of forbidden) assert.equal(source.includes(token), false, `${relative(root, path)} contains ${token}`);
  }
});

test("MIT attribution pins OldSuns/pi-open-tui commit c280fcd", () => {
  const license = readFileSync(join(root, "LICENSES/pi-open-tui-MIT.txt"), "utf8");
  assert.match(license, /OldSuns\/pi-open-tui/);
  assert.match(license, /c280fcd/);
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2026 pi-open-tui contributors/);
});
