import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { readAppearanceConfig } from "../lib/config.ts";

const dirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "appearance-config-"));
  dirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

function writeConfig(value: string): string {
  const dir = agentDir();
  writeFileSync(join(dir, "terrific.json"), value);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

describe("global appearance config", () => {
  it("is inactive when terrific.json is missing", () => assert.deepEqual(readAppearanceConfig(agentDir()), { active: false }));
  it("is inactive for an empty object", () => { writeConfig("{}"); assert.deepEqual(readAppearanceConfig(), { active: false }); });
  it("activates only the exact native profile", () => { writeConfig(JSON.stringify({ appearance: { profile: "terrific-native-v1" } })); assert.deepEqual(readAppearanceConfig(), { active: true }); });
  it("is inactive when explicitly off", () => { writeConfig(JSON.stringify({ appearance: { profile: "off" } })); assert.deepEqual(readAppearanceConfig(), { active: false }); });
  it("is inactive for unknown and non-string profiles", () => {
    for (const profile of ["future", 1, null, true]) {
      writeConfig(JSON.stringify({ appearance: { profile } }));
      assert.deepEqual(readAppearanceConfig(), { active: false });
    }
  });
  it("fails closed when appearance is not an object", () => { writeConfig(JSON.stringify({ appearance: "on" })); const result = readAppearanceConfig(); assert.equal(result.active, false); assert.match(result.error ?? "", /appearance/i); });
  it("fails closed on malformed JSON", () => { writeConfig("{"); const result = readAppearanceConfig(); assert.equal(result.active, false); assert.match(result.error ?? "", /parse|json/i); });
  it("ignores project-local activation and exercises PI_CODING_AGENT_DIR", () => {
    const global = writeConfig(JSON.stringify({ appearance: { profile: "off" } }));
    const project = mkdtempSync(join(tmpdir(), "appearance-project-")); dirs.push(project);
    mkdirSync(join(project, ".pi"));
    writeFileSync(join(project, ".pi", "terrific.json"), JSON.stringify({ appearance: { profile: "terrific-native-v1" } }));
    assert.equal(process.env.PI_CODING_AGENT_DIR, global);
    assert.deepEqual(readAppearanceConfig(), { active: false });
  });
});
