// The JS printer against the Zig printer over the whole corpus and the deep chains, one test per
// plan of `conformance.ts`. Code, source map mappings, and errors must match byte for byte.
//
// Skips when the corpus has not been downloaded so a bare `bun test` stays green. The Zig side
// is `zig build codegen-reference`, which `bun test:codegen` builds first.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corpusFiles, corpusPresent } from "../corpus";
import { deepChainFiles, describe as describeMismatch, PLANS, runPlan } from "./conformance";

const SAMPLE_MAX = 3;
const TIMEOUT_MS = 120_000;

describe.skipIf(!corpusPresent())("conformance with the Zig printer", () => {
  const dir = mkdtempSync(join(tmpdir(), "codegen-chains-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const files = [...corpusFiles(), ...deepChainFiles(dir)];

  for (const plan of PLANS) {
    test(
      plan.name,
      () => {
        const result = runPlan(plan, files);
        expect(result.compared).toBeGreaterThan(0);
        const sample = result.mismatches.slice(0, SAMPLE_MAX).map((m) => describeMismatch(m));
        expect(sample).toEqual([]);
        expect(result.mismatches.length).toBe(0);
      },
      TIMEOUT_MS,
    );
  }
});
