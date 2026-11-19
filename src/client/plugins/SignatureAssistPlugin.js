import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField } from "@codemirror/state";
import { EditorView, showTooltip } from "@codemirror/view";
import hydraData from "../../data/hydra-functions.json" assert { type: "json" };

const parameters = hydraData.functions.osc.params.map(({ name }) => name);
const dismiss = StateEffect.define();

export function oscCallAtCursor(state) {
  const { head, empty } = state.selection.main;
  if (!empty) return null;

  for (let node = syntaxTree(state).resolveInner(head, -1); node; node = node.parent) {
    if (node.name !== "ArgList" || node.parent?.name !== "CallExpression") continue;
    const close = node.lastChild;
    if (close?.name === ")" && head >= close.to) continue;

    const callee = node.parent.firstChild;
    if (callee?.name !== "VariableName" || state.sliceDoc(callee.from, callee.to) !== "osc") {
      return null;
    }
    let active = 0;
    for (let token = node.firstChild; token && token.to <= head; token = token.nextSibling) {
      if (token.name === ",") active++;
    }
    return { pos: callee.from, active };
  }
  return null;
}

const signature = StateField.define({
  create: () => null,
  update(previous, transaction) {
    if (transaction.effects.some((effect) => effect.is(dismiss))) return null;
    if (!transaction.docChanged && !transaction.selection) return previous;
    const call = oscCallAtCursor(transaction.state);
    if (!call) return null;
    if (call.pos === previous?.pos && call.active === previous.active) return previous;

    return {
      ...call,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "cm-signature-assist";
        dom.append("osc(");
        parameters.forEach((parameter, index) => {
          if (index) dom.append(", ");
          const label = document.createElement(index === call.active ? "strong" : "span");
          label.textContent = parameter;
          dom.append(label);
        });
        dom.append(")");
        return { dom };
      },
    };
  },
  provide: (field) => showTooltip.from(field),
});

const extension = [
  signature,
  EditorView.focusChangeEffect.of((_state, focused) => (focused ? null : dismiss.of(null))),
  EditorView.domEventObservers({
    keydown(event, view) {
      if (event.key === "Escape" && view.state.field(signature)) {
        view.dispatch({ effects: dismiss.of(null) });
      }
    },
  }),
  EditorView.baseTheme({
    ".cm-signature-assist": { padding: "4px 8px", pointerEvents: "none" },
    ".cm-signature-assist strong": { textDecoration: "underline" },
  }),
];

export function createSignatureAssistPlugin() {
  return {
    id: "signature-assist",
    name: "Signature Assist",
    setup({ editor, isMobile }) {
      if (isMobile) return;
      return editor.addExtension(extension);
    },
  };
}
