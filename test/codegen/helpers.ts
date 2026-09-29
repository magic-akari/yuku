import {
  parse,
  langFromPath,
  sourceTypeFromPath,
  type ParseOptions,
  type SourceLang,
} from "yuku-parser";
import { generate, type GenerateOptions } from "yuku-codegen";

export function gen(
  source: string,
  options: GenerateOptions = {},
  path = "input.ts",
  parseOptions: Partial<ParseOptions> = {},
): string {
  const ast = parse(source, {
    lang: langFromPath(path),
    sourceType: sourceTypeFromPath(path),
    attachComments: true,
    ...parseOptions,
  });
  return generate(ast.program, options).code;
}

const CHAIN_LINKS = 2_000;

/** Left-leaning chains nested far past the printers' recursion budgets. */
export function deepChains(): { source: string; lang: SourceLang }[] {
  const links: [string, SourceLang][] = [
    [" + b", "js"],
    [" || b", "js"],
    [".b", "js"],
    ["()", "js"],
    ["[0]", "js"],
    ["!.b<T>(c)`t`", "ts"],
    [" as T satisfies U", "ts"],
  ];
  return links.map(([link, lang]) => ({ source: `x = a${link.repeat(CHAIN_LINKS)};`, lang }));
}
