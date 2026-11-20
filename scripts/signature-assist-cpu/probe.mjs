// This loader runs only in the diagnostic process. The paired A/B uses the unmodified module.
export const cacheProbe = [];

export function installProbe() {
  globalThis.signatureCpuProbe = cacheProbe;
  Bun.plugin({
    name: "signature-assist-cpu-probe",
    setup(build) {
      build.onLoad({ filter: /\/customSignatures\.js$/ }, async ({ path }) => {
        let contents = await Bun.file(path).text();
        for (const [kind, expression] of [
          ["active", "indexCustomSignatures(source, tree)"],
          ["inactive", "indexCustomSignatures(source, parser.parse(source))"],
        ]) {
          const marker = `...${expression}`;
          if (!contents.includes(marker)) throw new Error(`Missing probe anchor: ${kind}`);
          contents = contents.replace(marker, `...measure("${kind}", () => ${expression})`);
        }
        contents += `
export { indexCustomSignatures };
function measure(kind, run) {
  const start = performance.now();
  const result = run();
  globalThis.signatureCpuProbe.push([kind, performance.now() - start]);
  return result;
}`;
        return { contents, loader: "js" };
      });
    },
  });
}
