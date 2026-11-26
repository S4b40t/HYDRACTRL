import { expect, test } from "bun:test";
import { CompletionContext, insertBracket, pickedCompletion } from "@codemirror/autocomplete";
import { history, undo } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { EditorState } from "@codemirror/state";
import { createCustomSignatureResolver } from "../client/plugins/customSignatures.js";
import { hydraCallAtCursor } from "../client/plugins/hydraSignature.js";
import { editorDelimiters } from "./editorDelimiters.js";
import { hydraCompletionScope, hydraCompletions } from "./hydraCompletions.js";

function editorState(source, extensions = []) {
  const pos = source.indexOf("|");
  return EditorState.create({
    doc: source.replace("|", ""),
    selection: { anchor: pos },
    extensions: [javascript(), editorDelimiters, history(), extensions],
  });
}

function complete(state) {
  return hydraCompletions(new CompletionContext(state, state.selection.main.head, true));
}

test.each([
  ["os|", "osc", "osc(|)"],
  ["osc().rot|", "rotate", "osc().rotate(|)"],
  ["osc().|", "rotate", "osc().rotate(|)"],
  ["os|(60)", "osc", "osc(|60)"],
  ["os| /* comment */ (60)", "osc", "osc /* comment */ (|60)"],
  ["osc().rot| (60)", "rotate", "osc().rotate (|60)"],
  ["os|c(60)", "osc", "osc(|60)"],
  ["outer(os|)", "osc", "outer(osc(|))"],
])("completes %s as a single undoable call", (source, name, expected) => {
  const initial = editorState(source);
  let picked;
  const view = {
    state: initial,
    dispatch(...specs) {
      const tr = this.state.update(...specs);
      picked = tr.annotation(pickedCompletion);
      this.state = tr.state;
    },
  };
  const { from, to, options } = complete(view.state);
  const option = options.find(({ label }) => label === name);
  option.apply(view, option, from, to);
  expect(view.state.doc.toString()).toBe(expected.replace("|", ""));
  expect(view.state.selection.main.head).toBe(expected.indexOf("|"));
  expect(hydraCallAtCursor(view.state)?.name).toBe(name);
  expect(picked).toBe(option);
  expect(undo({ state: view.state, dispatch: view.dispatch.bind(view) })).toBe(true);
  expect(view.state.doc.toString()).toBe(initial.doc.toString());
});

test("lists plain Hydra values and completes members on the matching receiver", () => {
  expect(complete(editorState("a.ff|")).options).toMatchObject([
    { label: "fft", type: "property" },
  ]);
  expect(complete(editorState("a.ff|")).options[0].apply).toBeUndefined();
  expect(complete(editorState("ti|")).options).toMatchObject([{ label: "time", type: "variable" }]);
  expect(complete(editorState("other.ff|"))).toBeNull();
  expect(complete(editorState("a?.ff|"))).toBeNull();
  expect(complete(editorState("s0.initC|")).options[0].label).toBe("initCam");
  expect(complete(editorState("[1].fa|")).options[0].label).toBe("fast");
});

test("shares visibility, shadowing, declarations, and documentation across both tabs", () => {
  let tab = "main";
  const docs = {
    setup: "/** Clamp the value. */\nfunction clamp(value, max = 1) {}\nconst count = n => n;",
    main: "",
  };
  const resolve = createCustomSignatureResolver({
    getCurrentTab: () => tab,
    getTabCode: (name) => docs[name],
  });
  const extensions = hydraCompletionScope.of({ resolve, getTransforms: () => undefined });
  const suggest = (source) => complete(editorState(source, extensions))?.options ?? [];
  expect(suggest("clam|")).toMatchObject([
    { label: "clamp", detail: "(value, max = 1)", info: "Clamp the value." },
  ]);
  expect(suggest("cou|")).toMatchObject([{ label: "count", detail: "(n)" }]);
  expect(suggest("function outer(clamp) { clam| }")).toEqual([]);
  expect(suggest("const clamp = 1;\nclam|")).toEqual([]);
  expect(suggest("function clamp(other) {}\nclam|")).toEqual([]);
  expect(suggest("const osc = 33;\nos|")).toEqual([]);
  expect(suggest("function osc(value) {}\nos|")[0]).toMatchObject({
    label: "osc",
    detail: "(value)",
    info: undefined,
  });
  expect(suggest("lo|;\nlet local = function (item) {};")).toEqual([]);
  expect(suggest("let local = function (item) {};\nlo|")).toMatchObject([
    { label: "local", detail: "(item)" },
  ]);
  docs.setup = "function clamp(value, max = 2) {}";
  expect(suggest("clam|")[0].detail).toBe("(value, max = 2)");
  docs.main = "function fromSketch(x) {}\nconst laterSketch = x => x;";
  tab = "setup";
  expect(suggest("fromS|")[0].label).toBe("fromSketch");
  expect(suggest("laterS|")).toEqual([]);
});

test("uses live registrations for generators and methods on known textures", () => {
  let transforms = {};
  const resolve = createCustomSignatureResolver({
    getCurrentTab: () => "main",
    getTabCode: () => "const carrier = () => osc();",
  });
  const scope = hydraCompletionScope.of({ resolve, getTransforms: () => transforms });
  const suggest = (source) => complete(editorState(source, scope))?.options ?? [];
  expect(suggest("custom|")).toEqual([]);
  transforms = {
    customSrc: { type: "src", inputs: [{ name: "amp", default: 1 }] },
    customBlend: { type: "combine", inputs: [{ name: "color" }, { name: "mix", default: 0.5 }] },
  };
  expect(suggest("custom|")).toMatchObject([{ label: "customSrc", detail: "(amp = 1)" }]);
  expect(suggest("customSrc().rotate().custom|")).toMatchObject([
    { label: "customBlend", detail: "(texture, mix = 0.5)" },
  ]);
  expect(suggest("carrier().custom|")[0]?.label).toBe("customBlend");
  expect(suggest("unknown().custom|")).toEqual([]);
  expect(suggest("a.setBandR|")).toEqual([]);
  expect(suggest("midiP|")).toEqual([]);
  expect(suggest("globalThis.hydractrlL|")).toEqual([]);
});

test("uses CodeMirror's tracked bracket pairs for nested delimiters and completion", () => {
  let state = editorState("osc|");
  const view = {
    state,
    dispatch(...specs) {
      this.state = this.state.update(...specs).state;
    },
  };
  const { from, to, options } = complete(state);
  options[0].apply(view, options[0], from, to);
  state = view.state;
  for (const bracket of ["[", "{", "}", "]", ")"]) state = insertBracket(state, bracket).state;
  expect(state.doc.toString()).toBe("osc([{}])");
  expect(state.selection.main.head).toBe(state.doc.length);
});

test("tracks a generated closer before an existing argument separator", () => {
  const view = {
    state: editorState("outer(os|, 2)"),
    dispatch(...specs) {
      this.state = this.state.update(...specs).state;
    },
  };
  const { from, to, options } = complete(view.state);
  options[0].apply(view, options[0], from, to);
  const closed = insertBracket(view.state, ")").state;
  expect(closed.doc.toString()).toBe("outer(osc(), 2)");
  expect(closed.selection.main.head).toBe("outer(osc()".length);
});

test.each(["// os|", "/* os| */", '"os|"', '"os|', "`os|`", "/os|/"])(
  "leaves delimiters literal and hides suggestions in %s",
  (source) => {
    const state = editorState(source);
    expect(insertBracket(state, "(")).toBeNull();
    expect(complete(state)).toBeNull();
  },
);

test.each(['"text"|', "/* text */|", "`text`|", "`text ${os|}`"])(
  "pairs delimiters in JavaScript at %s",
  (source) => {
    expect(insertBracket(editorState(source), "(")).not.toBeNull();
  },
);
