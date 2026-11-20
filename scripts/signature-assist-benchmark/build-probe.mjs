// Assemble a temporary diagnostic bundle. The normal build is left untouched.
import { readFile, writeFile } from "node:fs/promises";

function replace(contents, marker, replacement) {
  if (!contents.includes(marker)) throw new Error(`Missing diagnostic anchor: ${marker}`);
  return contents.replace(marker, replacement);
}

const timingHelpers = `
function recordProbe(kind, started, length) {
  const probe = globalThis.__signatureProbe;
  if (probe.phase) {
    probe.events.push({
      kind, length, phase: probe.phase, tab: probe.tab, operation: probe.operation,
      ms: started === undefined ? null : performance.now() - started,
    });
  }
}
function measureProbe(kind, work, length) {
  if (!globalThis.__signatureProbe.phase) return work();
  const started = performance.now();
  const result = work();
  recordProbe(kind, started, length);
  return result;
}`;

const result = await Bun.build({
  entrypoints: ["src/client/index.js"],
  target: "browser",
  minify: true,
  plugins: [
    {
      name: "signature-assist-diagnostic",
      setup(builder) {
        builder.onLoad(
          { filter: /[\\/](customSignatures|SignatureAssistPlugin)\.js$/ },
          async ({ path }) => {
            let contents = (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
            if (path.split(/[\\/]/).at(-1) === "customSignatures.js") {
              for (const [kind, expression] of [
                ["active", "indexCustomSignatures(source, tree)"],
                ["inactive", "indexCustomSignatures(source, parser.parse(source))"],
              ]) {
                // Match the call in the cache spread, excluding the function declaration.
                const marker = `...${expression}`;
                if (!contents.includes(marker))
                  throw new Error(`Cache probe anchor missing: ${kind}`);
                contents = replace(
                  contents,
                  marker,
                  `...measureProbe("${kind}", () => ${expression}, source.length)`,
                );
              }
              for (const [marker, replacement] of [
                [
                  "parser.parse(source)",
                  'measureProbe("inactive-parse", () => parser.parse(source), source.length)',
                ],
                [
                  "state.doc.toString()",
                  'measureProbe("source-materialize", () => state.doc.toString(), state.doc.length)',
                ],
                [
                  "editor.getTabCode(other)",
                  'measureProbe("inactive-read", () => editor.getTabCode(other))',
                ],
                [
                  "readSignatureJsdoc(source, declaration)",
                  'measureProbe("jsdoc", () => readSignatureJsdoc(source, declaration))',
                ],
                [
                  "if (!syntaxTreeAvailable(state)) return null;",
                  'if (!syntaxTreeAvailable(state)) { recordProbe("tree-deferred"); return null; }',
                ],
                [
                  "if (tree.length !== state.doc.length) return null;",
                  'if (tree.length !== state.doc.length) { recordProbe("tree-partial"); return null; }',
                ],
                [
                  "if (cache.get(tab)?.source !== source) {",
                  'recordProbe(cache.get(tab)?.source === source ? "active-hit" : "active-miss");\n      if (cache.get(tab)?.source !== source) {',
                ],
                [
                  "activeTree = tree;\n    }",
                  'activeTree = tree;\n    } else { recordProbe("active-hit"); }',
                ],
                [
                  "if (cache.get(other)?.source !== source) {",
                  'recordProbe(cache.get(other)?.source === source ? "inactive-hit" : "inactive-miss");\n    if (cache.get(other)?.source !== source) {',
                ],
                [
                  "  for (let node = tree.topNode.firstChild;",
                  "  const collectStarted = performance.now();\n  for (let node = tree.topNode.firstChild;",
                ],
                [
                  "  function block(node)",
                  '  recordProbe("top-level", collectStarted, source.length);\n\n  function block(node)',
                ],
                ["  tree.iterate({", "  const walkStarted = performance.now();\n  tree.iterate({"],
                [
                  "  return { bindings, nested };",
                  '  recordProbe("bindings-walk", walkStarted, source.length);\n  return { bindings, nested };',
                ],
              ])
                contents = replace(contents, marker, replacement);
            } else {
              for (const [marker, replacement] of [
                [
                  "const call = hydraCallAtCursor",
                  'const call = measureProbe("call-context", () => hydraCallAtCursor',
                ],
                [
                  "if (lookup === undefined) lookup = resolve(transaction.state);",
                  'if (lookup === undefined) lookup = measureProbe("resolve", () => resolve(transaction.state));',
                ],
                [
                  "return lookup ? lookup(name, position) : null;\n      });",
                  'return lookup ? measureProbe("lookup", () => lookup(name, position)) : null;\n      }));',
                ],
                [
                  "      )\n        return previous;\n\n      return {",
                  '      ) {\n        recordProbe("tooltip-reuse");\n        return previous;\n      }\n\n      return {',
                ],
                [
                  'const dom = document.createElement("div");',
                  'const domStarted = performance.now();\n          const dom = document.createElement("div");',
                ],
                [
                  "return { dom };",
                  'recordProbe("tooltip-create", domStarted);\n          return { dom };',
                ],
                [
                  "  return [\n    signature,",
                  `  const extension = [
    signature,`,
                ],
                [
                  "  ];\n}\n\nexport function createSignatureAssistPlugin()",
                  `  ];
  globalThis.__signatureProbe.extensionRefs = [
    new WeakRef(extension[0]),
    new WeakRef(extension[1].value),
    new WeakRef(extension[2]),
  ];
  globalThis.__signatureProbe.focusEffect = EditorView.focusChangeEffect;
  return extension;
}

export function createSignatureAssistPlugin()`,
                ],
              ])
                contents = replace(contents, marker, replacement);
              contents +=
                "\nglobalThis.__signatureProbe.install = () => window.hydractrl.registerPlugin(createSignatureAssistPlugin());";
            }
            contents += timingHelpers;
            return { contents, loader: "js" };
          },
        );
      },
    },
  ],
});
if (!result.success) throw new Error(result.logs.map(String).join("\n"));
await writeFile(process.argv[2], await result.outputs[0].text());
