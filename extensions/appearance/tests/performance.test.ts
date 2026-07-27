import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { p95 } from "../benchmarks/p95.ts";

describe("performance statistics", () => {
  it("uses deterministic nearest-rank p95 without mutating samples", () => {
    const samples = Array.from({ length: 30 }, (_, index) => 30 - index);
    assert.equal(p95(samples), 29);
    assert.deepEqual(samples, Array.from({ length: 30 }, (_, index) => 30 - index));
  });

  it("rejects an empty sample set", () => {
    assert.throws(() => p95([]), /at least one sample/);
  });
});
