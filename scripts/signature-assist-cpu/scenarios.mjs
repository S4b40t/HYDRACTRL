// Reuse the exact fixture text embedded in the published web benchmark.
export function scenarios({ setup, sketch }) {
  const bound = (documentation = "Lower bound.", label = "min") => [
    "benchClamp",
    label,
    documentation,
    "Restricts a value to a specified range.",
  ];
  const native = ["osc", "frequency", null, null];
  const setupCall = "benchClamp(0.4, 0.1";
  const customCall = "benchClamp(0.5, 11";
  const nativeCall = "osc(11";
  const extraCall = "cpuHelper(1, 2";
  const extraSketch = `const sampleExtra = () => ${extraCall});\n${sketch}`;
  const helper = "\nfunction cpuHelper(left, right = 2) { return left + right; }";
  const extraHint = ["cpuHelper", "right = 2", null, null];

  function target(tab, source, needle, expected) {
    const offset = source.indexOf(needle);
    if (offset < 0) throw new Error(`Fixture is missing ${needle}`);
    return { tab, source, anchor: offset + needle.length, expected };
  }

  const main = (source, needle, expected) => target("main", source, needle, expected);
  const inSetup = (source, needle, expected) => target("setup", source, needle, expected);
  function scenario(name, a, b, replaceDocument = false) {
    return { name, setup, sketch, a, b, replaceDocument };
  }

  const defaultChange = setup.replace("min, max) =>", "min = 0.25, max) =>");
  const slotSource = `${extraSketch}\n/** Slot helper. */${helper.replace("right = 2", "right = 3")}`;

  function editLiteral(operation, needle, expected) {
    const edited = needle.replace("11", "12");
    return scenario(
      operation,
      main(sketch, needle, expected),
      main(sketch.replace(needle, edited), edited, expected),
    );
  }

  return [
    scenario("cursor", main(sketch, nativeCall, native), main(sketch, customCall, bound())),
    editLiteral("native-literal", nativeCall, native),
    editLiteral("custom-literal", customCall, bound()),
    editLiteral("nested-literal", "osc(benchClamp(0.5, 11", bound()),
    scenario(
      "helper-body",
      inSetup(setup, setupCall, bound()),
      inSetup(setup.replace("Math.min(", "Math.max("), setupCall, bound()),
    ),
    scenario(
      "create",
      main(extraSketch, extraCall, null),
      main(extraSketch + helper, extraCall, extraHint),
    ),
    scenario(
      "rename",
      main(extraSketch + helper, extraCall, extraHint),
      main(
        extraSketch + helper.replace("function cpuHelper", "function renamedHelper"),
        extraCall,
        null,
      ),
    ),
    scenario(
      "delete",
      main(extraSketch + helper, extraCall, extraHint),
      main(extraSketch, extraCall, null),
    ),
    scenario(
      "parameter",
      inSetup(setup, setupCall, bound()),
      inSetup(defaultChange, setupCall, bound("Lower bound.", "min = 0.25")),
    ),
    scenario(
      "documentation",
      inSetup(setup, setupCall, bound()),
      inSetup(setup.replace("Lower bound.", "Lower limit."), setupCall, bound("Lower limit.")),
    ),
    scenario(
      "shadow",
      main(sketch, nativeCall, native),
      main(sketch + "\nconst osc = 12;", nativeCall, null),
    ),
    scenario(
      "local-shadow",
      main(sketch, nativeCall, native),
      main(sketch.replace("sampleNative = ()", "sampleNative = (osc)"), nativeCall, null),
    ),
    scenario("tab", main(sketch, customCall, bound()), inSetup(setup, setupCall, bound()), true),
    scenario(
      "slot",
      main(extraSketch + helper, extraCall, extraHint),
      main(slotSource, extraCall, ["cpuHelper", "right = 3", null, "Slot helper."]),
      true,
    ),
  ];
}
