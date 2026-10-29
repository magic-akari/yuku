import { describe, expect, test } from "bun:test";
import { BindingFlags, parse, type SourceFile } from "yuku";
import { summary } from "./utils/summarize";

function spaces(file: SourceFile, name: string): [value: boolean, type: boolean] {
  const binding = file.bindings.find((candidate) => candidate.name === name)!;
  return [binding.has(BindingFlags.ValueSpace), binding.has(BindingFlags.TypeSpace)];
}

describe("variable kinds", () => {
  test("var, let, const, using", () => {
    expect(summary(`var a = 1; let b = 2; const c = 3; using d = e();`, { path: "input.js" }))
      .toMatchInlineSnapshot(`
        "global
          module [strict]
            a#0  var
            b#1  let
            c#2  const
            d#3  const
            e → free"
      `);
  });

  test("function and class, declaration and expression", () => {
    expect(
      summary(`function f() {} class C {} const g = function () {}; const D = class {};`, {
        path: "input.js",
      }),
    ).toMatchInlineSnapshot(`
        "global
          module [strict]
            f#0  function
            C#1  class
            g#2  const
            D#3  const
            function "f"
              functionBody BlockStatement
            class "C"
            function <anonymous>
              functionBody BlockStatement
            class <anonymous>"
      `);
  });

  test("parameters: simple, default, rest, destructured", () => {
    expect(
      summary(`function f(a, b = 1, ...rest) {} const g = ({ x }, [y]) => x + y;`, {
        path: "input.js",
      }),
    ).toMatchInlineSnapshot(`
        "global
          module [strict]
            f#0  function
            g#4  const
            function "f"
              a#1  param
              b#2  param
              rest#3  param
              functionBody BlockStatement
            function =>
              x#5  param
              y#6  param
              x → #5
              y → #6"
      `);
  });

  test("a catch binding is a function-scoped variable", () => {
    expect(summary(`try {} catch (err) {}`, { path: "input.js" })).toMatchInlineSnapshot(`
      "global
        module [strict]
          block BlockStatement
          block CatchClause
            err#0  catch"
    `);
  });
});

describe("Annex B block functions", () => {
    test("sloppy scripts keep separate lexical and var bindings", () => {
        // inspect both environments and the recursive reference inside the declaration
        expect(summary(`{ function inner() { return inner; } } inner();`, {
            lang: "js", sourceType: "script",
        })).toMatchInlineSnapshot(`
          "global
            inner#1  var
            inner → #1
            block BlockStatement
              inner#0  function
              function "inner"
                functionBody BlockStatement
                  inner → #0"
        `);
        expect(summary(`function outer() { { function inner() {} } inner(); }`, {
            lang: "js", sourceType: "script",
        })).toMatchInlineSnapshot(`
          "global
            outer#0  function
            function "outer"
              inner#2  var
              functionBody BlockStatement
                inner → #2
                block BlockStatement
                  inner#1  function
                  function "inner"
                    functionBody BlockStatement"
        `);
        expect(summary(`if (condition) function inner() { return inner; } inner();`, {
            lang: "js", sourceType: "script",
        })).toMatchInlineSnapshot(`
          "global
            inner#1  var
            condition → free
            inner → #1
            block FunctionDeclaration
              inner#0  function
              function "inner"
                functionBody BlockStatement
                  inner → #0"
        `);
    });

    test("completed lexical environments decide which functions get companions", () => {
        // count companion declarations, including blockers declared after the candidate
        const cases: [string, number][] = [
            ["{ function f() {} } f;", 1],
            ["{ function f() { 'use strict'; } } f;", 1],
            ["if (condition) function f() { 'use strict'; } f;", 1],
            ["{ function f() {} function f(value) {} } f;", 2],
            ["{ function f() {} { function f(value) {} } } f;", 1],
            ["{ { function f(value) {} } function f() {} } f;", 1],
            ["{ function f() {} } { function f(value) {} } f;", 2],
            ["{ function f() {} if (condition) function f(value) {} } f;", 1],
            ["switch (value) { case 0: function f() {} } f;", 1],
            ["try {} catch { function f() {} } f;", 1],
            ["try {} catch (f) { { function f() {} } } f;", 1],
            ["try {} catch ({f}) { { function f() {} } } f;", 0],
            ["try {} catch ([f = 1]) { { function f() {} } } f;", 0],
            ["let f; { function f() {} }", 0],
            ["{ function f() {} } let f;", 0],
            ["{ let f; { function f() {} } }", 0],
            ["{ { function f() {} } let f; }", 0],
            ["{ class f {} { function f() {} } }", 0],
            ["{ function* f() {} } f;", 0],
            ["{ async function f() {} } f;", 0],
            ["'use strict'; { function f() {} } f;", 0],
            ["function outer() { 'use strict'; { function f() {} } f; }", 0],
            ["function outer(f) { { function f() {} } f; }", 0],
            ["function outer(f = 1) { { function f() {} } f; }", 0],
            ["function outer(value = 1) { { function f() {} } f; }", 1],
            ["let f; function outer() { { function f() {} } f; }", 1],
            ["{ function f() {} function g() { { function f() {} } f; } }", 2],
            ["if (condition) function f() {} else function f(value) {} f;", 2],
        ];
        for (const lang of ["js", "ts"] as const) {
            for (const semanticErrors of [false, true]) {
                for (const [source, count] of cases) {
                    const file = parse(source, {
                        lang, sourceType: "script", semantic: true, semanticErrors,
                    });
                    expect(file.diagnostics, source).toEqual([]);
                    const companions = file.bindings.filter((binding) =>
                        binding.name === "f" &&
                        binding.has(BindingFlags.FunctionScopedVariable) &&
                        !binding.has(BindingFlags.Parameter | BindingFlags.CatchVariable));
                    const declarations = companions.flatMap((binding) => binding.declarations);
                    expect(declarations.length, source).toBe(count);
                    for (const binding of companions) {
                        for (const declaration of binding.declarations) {
                            const lexical = file.bindingOf(declaration)!;
                            expect(lexical, source).not.toBe(binding);
                            expect(lexical.has(BindingFlags.Function), source).toBe(true);
                            expect(lexical.scope.kind, source).toBe("block");
                        }
                    }
                }
            }
        }
    });

    test("companions merge with vars without replacing the lexical declaration link", () => {
        // declaration order stays lexical even when the explicit var comes later
        for (const source of [
            "var f; { function f() { return f; } } f;",
            "{ function f() { return f; } } var f; f;",
            "function f() {} { function f() { return f; } } f;",
        ]) {
            const file = parse(source, { lang: "js", sourceType: "script", semantic: true });
            expect(file.diagnostics).toEqual([]);
            const outer = file.rootScope.find("f")!;
            expect(outer.declarations).toHaveLength(2);
            expect(outer.declarations[0]!.start).toBeLessThan(outer.declarations[1]!.start);
            const [innerUse, outerUse] = file.references;
            expect(innerUse!.binding).not.toBe(outer);
            expect(outerUse!.binding).toBe(outer);
            const lexical = innerUse!.binding!;
            expect(file.bindingOf(lexical.declarations[0]!)).toBe(lexical);
        }
    });

    test("an ancestor block function prevents a nested companion of the same name", () => {
        // only the outer declaration contributes, regardless of its position in the block
        for (const source of [
            "{ function f() {} { function f(value) {} } } f;",
            "{ { function f(value) {} } function f() {} } f;",
            "{ function f() {} if (condition) function f(value) {} } f;",
            "switch (value) { case 0: function f() {} { function f(value) {} } } f;",
        ]) {
            const file = parse(source, { lang: "js", sourceType: "script", semantic: true });
            expect(file.diagnostics).toEqual([]);
            const outer = file.rootScope.find("f")!;
            expect(outer.declarations.map((node) => node.start)).toEqual([source.indexOf("f()")]);
        }
    });

    test("modules and implicit arguments do not gain companion bindings", () => {
        // strict modules and the implicit arguments object keep their existing resolution
        expect(summary("{ function f() {} } f;", { lang: "js", sourceType: "module" }))
            .toMatchInlineSnapshot(`
              "global
                module [strict]
                  f → free
                  block BlockStatement
                    f#0  function
                    function "f"
                      functionBody BlockStatement"
            `);
        expect(summary("function outer() { { function arguments() {} } arguments; }", {
            lang: "js", sourceType: "script",
        })).toMatchInlineSnapshot(`
          "global
            outer#0  function
            function "outer"
              functionBody BlockStatement
                arguments → free
                block BlockStatement
                  arguments#1  function
                  function "arguments"
                    functionBody BlockStatement"
        `);
    });

    test("an invalid block redeclaration does not create a companion", () => {
        // recovery can reuse a catch or var binding instead of declaring a lexical function
        for (const source of [
            "try {} catch (f) { function f() {} } f;",
            "{ var f; function f() {} } f;",
        ]) {
            const file = parse(source, {
                lang: "js", sourceType: "script", semantic: true, semanticErrors: true,
            });
            expect(file.diagnostics.length).toBeGreaterThan(0);
            expect(file.bindings).toHaveLength(1);
        }
    });

    test("a class merged with a block function prevents its companion", () => {
        // the shared symbol must retain the class's lexical restriction
        const file = parse("{ declare class f {} function f() {} } f;", {
            lang: "ts", sourceType: "script", semantic: true, semanticErrors: true,
        });
        expect(file.diagnostics).toEqual([]);
        expect(file.bindings).toHaveLength(1);
        expect(file.references[0]!.binding).toBeNull();
    });
});

describe("TypeScript declarations", () => {
  test("interface, type alias, enum, const enum", () => {
    expect(summary(`interface I {} type A = number; enum E {} const enum CE {}`))
      .toMatchInlineSnapshot(`
        "global
          module [strict]
            I#0  interface
            A#1  type
            E#2  enum
            CE#3  const-enum
            block TSInterfaceDeclaration
            block TSTypeAliasDeclaration
            block TSEnumBody
            block TSEnumBody"
      `);
  });

  test("a value namespace vs a type-only namespace", () => {
    expect(summary(`namespace V { export const x = 1; } namespace T { type Y = 1; }`))
      .toMatchInlineSnapshot(`
        "global
          module [strict]
            V#0  namespace value-module
            T#2  namespace
            tsModule
              x#1  const exported
            tsModule
              Y#3  type
              block TSTypeAliasDeclaration"
      `);
  });

  test("namespace members bind in the tsModule scope and resolve", () => {
    expect(summary(`namespace N { const x = 1; x; }`)).toMatchInlineSnapshot(`
      "global
        module [strict]
          N#0  namespace value-module
          tsModule
            x#1  const
            x → #1"
    `);
  });

  test("a type parameter and an infer binding", () => {
    expect(summary(`type F<T> = T extends Array<infer U> ? U : never;`)).toMatchInlineSnapshot(`
      "global
        module [strict]
          F#0  type
          block TSTypeAliasDeclaration
            T#1  type-param
            block TSConditionalType
              U#2  type-param
              T → #1 type
              Array → free type
              U → #2 type"
    `);
  });

  test("every declare form carries the ambient flag", () => {
    expect(summary(`declare const x: number; declare function f(a: number): void;`))
      .toMatchInlineSnapshot(`
        "global
          module [strict]
            x#0  const ambient
            f#1  function ambient
            function "f"
              a#2  param ambient"
      `);
  });

  test("a declare namespace makes its whole body ambient", () => {
    // an ambient binding skips strict reserved-word checks
    expect(summary(`declare namespace Foo { export var static: any; namespace Inner { var y; } }`))
      .toMatchInlineSnapshot(`
        "global
          module [strict]
            Foo#0  namespace value-module ambient
            tsModule
              static#1  var ambient exported
              Inner#2  namespace value-module ambient exported
              tsModule
                y#3  var ambient exported"
      `);
  });

  test("a declare enum makes its members ambient", () => {
    expect(summary(`declare enum E { A }\nenum E { B }`)).toMatchInlineSnapshot(`
      "global
        module [strict]
          E#0  enum ×2
          block TSEnumBody
            A#1  ambient
          block TSEnumBody
            B#2  "
    `);
  });
});

describe("declaration merging", () => {
  test("function overloads merge into one binding with every declarator", () => {
    expect(
      summary(`function f(a: number): void; function f(a: string): void; function f(a: any) {}`),
    ).toMatchInlineSnapshot(`
        "global
          module [strict]
            f#0  function ×3
            function "f"
              a#1  param ambient
            function "f"
              a#2  param ambient
            function "f"
              a#3  param
              functionBody BlockStatement"
      `);
  });

  test("class and interface merge", () => {
    expect(summary(`class C {} interface C {}`)).toMatchInlineSnapshot(`
      "global
        module [strict]
          C#0  class interface ×2
          class "C"
          block TSInterfaceDeclaration"
    `);
  });

  test("enum and namespace merge", () => {
    expect(summary(`enum E { A } namespace E { export const b = 1; }`)).toMatchInlineSnapshot(`
      "global
        module [strict]
          E#0  enum namespace value-module ×2
          block TSEnumBody
            A#1  
          tsModule
            b#2  const exported"
    `);
  });

  test("function and namespace merge", () => {
    expect(summary(`function f() {} namespace f { export const g = 1; }`)).toMatchInlineSnapshot(`
      "global
        module [strict]
          f#0  function namespace value-module ×2
          function "f"
            functionBody BlockStatement
          tsModule
            g#1  const exported"
    `);
  });
});

describe("modifiers", () => {
  test("exported and default flags", () => {
    expect(summary(`export const a = 1; export default function named() {}`))
      .toMatchInlineSnapshot(`
        "global
          module [strict]
            a#0  const exported
            named#1  function exported default
            function "named"
              functionBody BlockStatement
        exports
          a → #0
          default → #1"
      `);
  });

  test("value-space and type-space imports", () => {
    expect(summary(`import v from "./v"; import type T from "./t"; import { type N } from "./n";`))
      .toMatchInlineSnapshot(`
        "global
          module [strict]
            v#0  import
            T#1  type-import
            N#2  type-import
        imports
          default → #0 from "./v"
          default → #1 from "./t" type
          N → #2 from "./n" type"
      `);
  });
});

describe("value space and type space", () => {
  test("a class is in both spaces, an interface and an alias in type, a const in value", () => {
    const source = `class C {} interface I {} type A = 1; const v = 1;`;
    const file = parse(source, { semantic: true, path: "input.ts" });
    expect(spaces(file, "C")).toEqual([true, true]);
    expect(spaces(file, "I")).toEqual([false, true]);
    expect(spaces(file, "A")).toEqual([false, true]);
    expect(spaces(file, "v")).toEqual([true, false]);
  });

  test("an enum lives in both spaces", () => {
    const file = parse(`enum E { A }`, { semantic: true, path: "input.ts" });
    expect(spaces(file, "E")).toEqual([true, true]);
  });
});
