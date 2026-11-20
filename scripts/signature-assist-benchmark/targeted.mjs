import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { javascript } from "@codemirror/lang-javascript";
import { sha256 } from "./server.mjs";

const reviewedSha256 = "dc8fc01531c058172a51da081c35479f7320e7de408c2a706c749d4b413d2324";
const sketch = `const sampleNative = () => osc(11, 0.1, 0).rotate(0.1);
const sampleCustom = () => clamp(0.5, 11, 20);
const sampleNested = () => osc(clamp(0.5, 11, 20), 0.1).out();
const palette = colorRamp(["#d14f83", "#2e4aa7", "#27b898"], () => phase(12));
const benchmarkScene = osc(12, 0.06, 0.7)
  .modulate(noise(3, 0.2), 0.06)
  .scale(() => lerp(0.95, 1.05, audioLevel(0, 1, 0.1)))
  .rotate(0.2, 0.05).color(...palette);
benchmarkScene.out(o0);`;

function setupVariant(
  name = "benchSetupProbe",
  amount = 1,
  operator = "+",
  summary = "Applies an offset.",
) {
  const call = `${name}(0.4, 0.2)`;
  return {
    code: `\n/**\n * ${summary}\n * @param {number} amount Offset to apply.\n */\nfunction ${name}(value, amount = ${amount}) { return value ${operator} amount; }\nconst benchSetupCall = () => ${call};\n`,
    call,
    hint: {
      label: `${name}(value, amount = ${amount})`,
      active: `amount = ${amount}`,
      summary,
      argument: "Offset to apply.",
    },
  };
}

export async function loadTargetedFixture(file) {
  const bytes = await readFile(file);
  const hash = sha256(bytes);
  assert.equal(
    hash,
    reviewedSha256,
    "Setup must match the locally vetted fixture before execution",
  );
  const setup = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const fixtureTree = javascript().language.parser.parse(setup);
  const declarations = fixtureTree.topNode.getChildren("FunctionDeclaration");
  const helperCount = declarations.filter((node) => {
    const comment = node.prevSibling;
    return comment?.name === "BlockComment" && setup.startsWith("/**", comment.from);
  }).length;
  assert.equal(helperCount, 30, "Unexpected documented helper count");
  const clampNode = declarations.find((node) => {
    const binding = node.getChild("VariableDefinition");
    return binding && setup.slice(binding.from, binding.to) === "clamp";
  });
  const docs = setup.slice(clampNode.prevSibling.from, clampNode.prevSibling.to);
  const parameters = clampNode
    .getChild("ParamList")
    .getChildren("VariableDefinition")
    .map(({ from, to }) => setup.slice(from, to));
  assert.equal(parameters.length, 3, "Expected the reviewed clamp signature");
  const active = parameters[1];
  const customHint = {
    label: `clamp(${parameters.join(", ")})`,
    active,
    summary: docs.match(/\* ([^\r\n]+)\r?\n/)[1],
    argument: docs
      .split(/\r?\n/)
      .map((line) => line.split(`@param {number} ${active} `)[1])
      .find(Boolean),
  };
  let firstArgumentEnd;
  fixtureTree.iterate({
    enter(ref) {
      if (firstArgumentEnd !== undefined) return false;
      if (ref.name !== "CallExpression") return;
      const callee = ref.node.firstChild;
      if (callee?.name === "VariableName" && setup.slice(callee.from, callee.to) === "clamp") {
        firstArgumentEnd = ref.node.getChild("ArgList")?.getChild(",")?.from;
      }
    },
  });
  assert.ok(firstArgumentEnd !== undefined, "Expected a clamp call in Setup");
  const setupCursor = setup.slice(0, firstArgumentEnd).replaceAll("\r\n", "\n").length;
  const original = setupVariant();
  const malformed = {
    ...original,
    code: original.code.replace(original.call, "("),
    call: null,
    hint: null,
  };
  return {
    size: "real-setup",
    setup,
    sketch,
    customHint,
    setupCursor,
    metadata: {
      setupSha256: hash,
      setupBytes: bytes.length,
      setupCharacters: [...setup].length,
      helperCount,
      sketchSha256: sha256(sketch),
    },
    setupScenarios: {
      body: [original, setupVariant(undefined, 1, "-")],
      parameter: [original, setupVariant(undefined, 2)],
      declaration: [original, setupVariant("benchRenamedProbe")],
      jsdoc: [original, setupVariant(undefined, 1, "+", "Applies a revised offset.")],
      recovery: [malformed, original],
    },
  };
}
