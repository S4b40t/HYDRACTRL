import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { EditorState, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";

const codeBrackets = { brackets: ["(", "[", "{"], before: ")]}:;>,." };
const literalBrackets = { brackets: [] };

export function inJavaScriptLiteral(state, position) {
  for (let node = syntaxTree(state).resolveInner(position, -1); node; node = node.parent) {
    switch (node.name) {
      case "LineComment":
        return true;
      case "BlockComment":
      case "String":
      case "RegExp":
      case "TemplateString":
        return position < node.to || Boolean(node.getChild("⚠"));
      case "Interpolation":
        return false;
    }
  }
  return false;
}

export const editorDelimiters = [
  closeBrackets(),
  keymap.of(closeBracketsKeymap),
  Prec.high(
    EditorState.languageData.of((state, position) => [
      { closeBrackets: inJavaScriptLiteral(state, position) ? literalBrackets : codeBrackets },
    ]),
  ),
];
