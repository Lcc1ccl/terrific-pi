import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadAppearanceConfig, writeAppearanceSection } from "../lib/config.ts";

const valid = { enabled: true, settingsLanguage: "en", header: true, editor: true } as const;

describe("appearance config", () => {
  it("fails closed when the global section is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "appearance-absent-"));
    assert.deepEqual(loadAppearanceConfig(dir), { config: undefined });
  });

  it("fails closed for malformed JSON, root, section, and schema fields", () => {
    const cases: unknown[] = ["{ bad", [], { appearance: true }, { appearance: { ...valid, enabled: "yes" } }, { appearance: { enabled: true } }];
    for (const [index, value] of cases.entries()) {
      const dir = mkdtempSync(join(tmpdir(), `appearance-bad-${index}-`));
      writeFileSync(join(dir, "terrific.json"), typeof value === "string" ? value : JSON.stringify(value), "utf8");
      const result = loadAppearanceConfig(dir);
      assert.equal(result.config, undefined);
      assert.match(result.error ?? "", /appearance|terrific\.json/i);
    }
  });

  it("accepts exactly the global appearance schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "appearance-valid-"));
    writeFileSync(join(dir, "terrific.json"), JSON.stringify({ appearance: valid }), "utf8");
    assert.deepEqual(loadAppearanceConfig(dir), { config: valid });
  });

  it("atomically writes only the appearance section and preserves siblings", () => {
    const dir = mkdtempSync(join(tmpdir(), "appearance-write-"));
    const path = join(dir, "terrific.json");
    writeFileSync(path, JSON.stringify({ mode: { default: "ask" }, appearance: { old: true } }), "utf8");
    const result = writeAppearanceSection(valid, dir);
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { mode: { default: "ask" }, appearance: valid });
    assert.equal(existsSync(`${path}.lock`), false);
  });

  it("refuses an owned lock and malformed existing JSON without overwriting", () => {
    const dir = mkdtempSync(join(tmpdir(), "appearance-refuse-"));
    const path = join(dir, "terrific.json");
    writeFileSync(path, "{ bad", "utf8");
    assert.equal(writeAppearanceSection(valid, dir).ok, false);
    assert.equal(readFileSync(path, "utf8"), "{ bad");

    writeFileSync(path, JSON.stringify({ keep: true }), "utf8");
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, token: "owner" }), "utf8");
    assert.equal(writeAppearanceSection(valid, dir).ok, false);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { keep: true });
  });
});
