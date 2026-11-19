// Assemble a temporary diagnostic bundle. The normal build is left untouched.
import { readFile, writeFile } from "node:fs/promises";

const result = await Bun.build({
  entrypoints: ["src/client/index.js"],
  target: "browser",
  minify: true,
  plugins: [
    {
      name: "signature-assist-diagnostic",
      setup(builder) {
        builder.onLoad(
          { filter: /\/(customSignatures|SignatureAssistPlugin)\.js$/ },
          async ({ path }) => {
            let contents = await readFile(path, "utf8");
            if (path.endsWith("/customSignatures.js")) {
              for (const [kind, expression] of [
                ["active", "indexCustomSignatures(source, tree)"],
                ["inactive", "indexCustomSignatures(source, parser.parse(source))"],
              ]) {
                // Match the call in the cache spread, excluding the function declaration.
                const marker = `...${expression}`;
                if (!contents.includes(marker))
                  throw new Error(`Cache probe anchor missing: ${kind}`);
                contents = contents.replace(
                  marker,
                  `...measureIndex("${kind}", source.length, () => ${expression})`,
                );
              }
              contents += `
function measureIndex(kind, length, build) {
  const probe = globalThis.__signatureProbe;
  const started = performance.now();
  const result = build();
  if (probe.phase) probe.events.push({ kind, length, phase: probe.phase, ms: performance.now() - started });
  return result;
}`;
            } else {
              contents +=
                "\nglobalThis.__signatureProbe.install = () => window.hydractrl.registerPlugin(createSignatureAssistPlugin());";
            }
            return { contents, loader: "js" };
          },
        );
      },
    },
  ],
});
if (!result.success) throw new Error(result.logs.map(String).join("\n"));
await writeFile(process.argv[2], await result.outputs[0].text());
