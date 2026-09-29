// Prints every corpus file and the deep chains with the Zig and the JS printer and compares
// code, mappings, and errors byte for byte.
//
//   bun test/codegen/conformance.ts [plan...] [--file <path>] [--show <n>]

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, sourceTypeFromPath, type ParseOptions } from "yuku-parser";
import { generate, type GenerateOptions } from "yuku-codegen";
import { corpusFiles, type CorpusFile } from "../corpus";
import { deepChains } from "./helpers";

const REFERENCE = "zig-out/bin/codegen-reference";

export interface Plan {
  name: string;
  /** Flags for `codegen-reference`. */
  zig: string[];
  /** The same options for `generate`, `sourceMap` added per file when `map` is set. */
  js: GenerateOptions;
  preserveParens: boolean;
  map: boolean;
}

export const PLANS: Plan[] = [
  { name: "default", zig: [], js: {}, preserveParens: true, map: false },
  {
    name: "all",
    zig: ["--comments=all"],
    js: { comments: "all" },
    preserveParens: true,
    map: false,
  },
  {
    name: "compact",
    zig: ["--compact", "--comments=all"],
    js: { format: "compact", comments: "all" },
    preserveParens: true,
    map: false,
  },
  {
    name: "strip",
    zig: ["--strip", "--comments=all"],
    js: { strip: true, comments: "all" },
    preserveParens: true,
    map: false,
  },
  {
    name: "minify",
    zig: ["--minify", "--compact", "--quotes=shortest", "--comments=all"],
    js: { minify: true, comments: "all" },
    preserveParens: true,
    map: false,
  },
  {
    name: "map",
    zig: ["--source-map", "--comments=all"],
    js: { comments: "all" },
    preserveParens: true,
    map: true,
  },
  {
    name: "noparens",
    zig: ["--no-preserve-parens", "--comments=all", "--quotes=double"],
    js: { comments: "all", quotes: "double" },
    preserveParens: false,
    map: false,
  },
  {
    name: "line",
    zig: ["--comments=line", "--indent=4", "--quotes=single"],
    js: { comments: "line", indent: 4, quotes: "single" },
    preserveParens: true,
    map: false,
  },
  {
    name: "block",
    zig: ["--compact", "--comments=block", "--quotes=double"],
    js: { format: "compact", comments: "block", quotes: "double" },
    preserveParens: true,
    map: false,
  },
  {
    name: "everything",
    zig: [
      "--strip",
      "--minify",
      "--compact",
      "--source-map",
      "--no-preserve-parens",
      "--quotes=single",
      "--comments=some",
      "--indent=4",
    ],
    js: {
      strip: true,
      minify: { syntax: true },
      format: "compact",
      quotes: "single",
      comments: "some",
      indent: 4,
    },
    preserveParens: false,
    map: true,
  },
];

export interface Mismatch {
  path: string;
  what: "code" | "map" | "errors" | "skip" | "threw";
  expected: string;
  actual: string;
}

export interface PlanResult {
  plan: string;
  compared: number;
  mismatches: Mismatch[];
}

interface Reference {
  printed: boolean;
  code: string;
  mappings: string;
  errors: { start: number; end: number; message: string }[];
}

/** Writes `deepChains` into `dir` as files both printers read. */
export function deepChainFiles(dir: string): CorpusFile[] {
  return deepChains().map(({ source, lang }, i) => {
    const relative = `chain-${i}.${lang}`;
    const path = join(dir, relative);
    writeFileSync(path, source);
    return { path, relative, lang, sourceType: sourceTypeFromPath(path) };
  });
}

/** Prints `files` with both printers under `plan`. */
export function runPlan(plan: Plan, files: CorpusFile[]): PlanResult {
  const references = runReference(plan, files);
  const mismatches: Mismatch[] = [];
  let compared = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const reference = references[i]!;
    const source = readFileSync(file.path, "utf8");
    const parseOptions: ParseOptions = {
      lang: file.lang,
      sourceType: file.sourceType,
      attachComments: true,
      preserveParens: plan.preserveParens,
    };
    const parsed = parse(source, parseOptions);
    const skipped = parsed.diagnostics.length > 0;
    if (skipped !== !reference.printed) {
      mismatches.push({
        path: file.path,
        what: "skip",
        expected: reference.printed ? "printed" : "skipped",
        actual: skipped ? "skipped" : "printed",
      });
      continue;
    }
    if (skipped) continue;
    compared++;

    const options: GenerateOptions = plan.map ? { ...plan.js, sourceMap: { source } } : plan.js;
    let result;
    try {
      result = generate(parsed.program, options);
    } catch (error) {
      mismatches.push({
        path: file.path,
        what: "threw",
        expected: "",
        actual: String((error as Error).stack ?? error),
      });
      continue;
    }
    if (result.code !== reference.code) {
      mismatches.push({
        path: file.path,
        what: "code",
        expected: reference.code,
        actual: result.code,
      });
      continue;
    }
    if (plan.map && result.map?.mappings !== reference.mappings) {
      mismatches.push({
        path: file.path,
        what: "map",
        expected: reference.mappings,
        actual: result.map?.mappings ?? "",
      });
      continue;
    }
    const expected = referenceErrors(reference, source);
    const actual = result.errors.map((e) => `${e.start}-${e.end} ${e.message}`).join("\n");
    if (actual !== expected) {
      mismatches.push({ path: file.path, what: "errors", expected, actual });
    }
  }
  return { plan: plan.name, compared, mismatches };
}

function runReference(plan: Plan, files: CorpusFile[]): Reference[] {
  if (!existsSync(REFERENCE)) {
    throw new Error(`${REFERENCE} is missing, build it with \`zig build codegen-reference\``);
  }
  const dir = mkdtempSync(join(tmpdir(), "codegen-conformance-"));
  try {
    const list = join(dir, "list.txt");
    const out = join(dir, "out.bin");
    writeFileSync(list, files.map((f) => f.path).join("\n") + "\n");
    const run = spawnSync(REFERENCE, [list, out, ...plan.zig], { stdio: "inherit" });
    if (run.status !== 0) throw new Error(`codegen-reference failed for plan ${plan.name}`);
    return readReference(readFileSync(out), files.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readReference(buf: Buffer, count: number): Reference[] {
  const references: Reference[] = [];
  let p = 0;
  const bytes = (): string => {
    const len = buf.readUInt32LE(p);
    p += 4;
    const s = buf.toString("utf8", p, p + len);
    p += len;
    return s;
  };
  for (let i = 0; i < count; i++) {
    const status = buf[p++];
    if (status !== 0) {
      references.push({ printed: false, code: "", mappings: "", errors: [] });
      continue;
    }
    const code = bytes();
    const mappings = bytes();
    const errorCount = buf.readUInt32LE(p);
    p += 4;
    const errors = [];
    for (let k = 0; k < errorCount; k++) {
      const start = buf.readUInt32LE(p);
      const end = buf.readUInt32LE(p + 4);
      p += 8;
      errors.push({ start, end, message: bytes() });
    }
    references.push({ printed: true, code, mappings, errors });
  }
  if (p !== buf.length) throw new Error("codegen-reference output has trailing bytes");
  return references;
}

// the Zig side counts UTF-8 bytes, the JS side UTF-16 units
function referenceErrors(reference: Reference, source: string): string {
  if (reference.errors.length === 0) return "";
  const units = utf16Offsets(source);
  return reference.errors.map((e) => `${units[e.start]}-${units[e.end]} ${e.message}`).join("\n");
}

function utf16Offsets(source: string): number[] {
  const units: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const code = source.codePointAt(i)!;
    const bytes = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    for (let k = 0; k < bytes; k++) units.push(i);
    if (code >= 0x10000) i++;
  }
  units.push(source.length);
  return units;
}

function firstDifference(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** A readable excerpt around the first difference of a mismatch. */
export function describe(m: Mismatch, context = 240): string {
  if (m.what === "threw" || m.what === "skip") return `${m.path} ${m.what}\n${m.actual}`;
  const at = firstDifference(m.expected, m.actual);
  const from = Math.max(0, at - context);
  return [
    `${m.path} ${m.what} differs at ${at}`,
    "--- zig",
    m.expected.slice(from, at + context),
    "--- js",
    m.actual.slice(from, at + context),
  ].join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const fileAt = args.indexOf("--file");
  const showAt = args.indexOf("--show");
  const show = showAt >= 0 ? Number(args[showAt + 1]) : 3;
  const only = fileAt >= 0 ? args[fileAt + 1] : undefined;
  const values = new Set([fileAt, showAt].filter((at) => at >= 0).map((at) => at + 1));
  const names = args.filter((a, i) => !a.startsWith("--") && !values.has(i));
  const plans = names.length > 0 ? PLANS.filter((p) => names.includes(p.name)) : PLANS;
  const dir = mkdtempSync(join(tmpdir(), "codegen-chains-"));
  const files = [...corpusFiles(), ...deepChainFiles(dir)].filter(
    (f) => only === undefined || f.path.includes(only),
  );
  let failed = false;
  for (const plan of plans) {
    const t0 = performance.now();
    const result = runPlan(plan, files);
    const ms = (performance.now() - t0).toFixed(0);
    console.log(
      `${plan.name.padEnd(11)} ${result.compared} compared, ` +
        `${result.mismatches.length} mismatched (${ms} ms)`,
    );
    const byKind = new Map<string, number>();
    for (const m of result.mismatches) byKind.set(m.what, (byKind.get(m.what) ?? 0) + 1);
    if (byKind.size > 0) {
      console.log("  " + [...byKind].map(([k, v]) => `${k} ${v}`).join(", "));
    }
    for (const m of result.mismatches.slice(0, show)) console.log(describe(m) + "\n");
    failed ||= result.mismatches.length > 0;
  }
  rmSync(dir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
