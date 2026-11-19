import { expect, test } from "bun:test";
import { javascript } from "@codemirror/lang-javascript";
import { EditorState } from "@codemirror/state";
import { oscCallAtCursor } from "./SignatureAssistPlugin.js";

test.each([
  ["osc(|", { pos: 0, active: 0 }],
  ["osc(60,|", { pos: 0, active: 1 }],
  ["osc([1, 2], /* , */ 0.1,|)", { pos: 0, active: 2 }],
  ["osc(osc(60,|", { pos: 4, active: 1 }],
  ["osc(osc(60)|", { pos: 0, active: 0 }],
  ["osc(osc(60),|", { pos: 0, active: 1 }],
  ["osc(60)|", null],
  ["osc|", null],
  ["osc(noise(1,|", null],
  ["other.osc(60,|", null],
])("osc call context in %s", (source, expected) => {
  const anchor = source.indexOf("|");
  const doc = source.replace("|", "");
  const state = EditorState.create({ doc, selection: { anchor }, extensions: [javascript()] });
  expect(oscCallAtCursor(state)).toEqual(expected);
});
