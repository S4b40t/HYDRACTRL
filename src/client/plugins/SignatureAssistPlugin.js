import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField } from "@codemirror/state";
import { EditorView, showTooltip } from "@codemirror/view";
import { hydraCallAtCursor } from "./hydraSignature.js";

const dismiss = StateEffect.define();

const signature = StateField.define({
  create: () => null,
  update(previous, transaction) {
    // A background parse update must not reopen a dismissed hint.
    if (transaction.effects.some((effect) => effect.is(dismiss))) return false;
    if (!transaction.docChanged && !transaction.selection) {
      if (
        previous === false ||
        syntaxTree(transaction.startState) === syntaxTree(transaction.state)
      ) {
        return previous;
      }
    }
    const call = hydraCallAtCursor(transaction.state);
    if (!call) return null;
    if (
      call.pos === previous?.pos &&
      call.active === previous.active &&
      call.name === previous.name
    )
      return previous;

    return {
      ...call,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "cm-signature-assist";
        dom.append(`${call.name}(`);
        call.params.forEach((parameter, index) => {
          if (index) dom.append(", ");
          const label = document.createElement(index === call.active ? "strong" : "span");
          label.textContent = Object.hasOwn(parameter, "default")
            ? `${parameter.name} = ${parameter.default}`
            : parameter.name;
          dom.append(label);
        });
        dom.append(")");
        return { dom };
      },
    };
  },
  provide: (field) => showTooltip.from(field, (value) => value || null),
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
    ".cm-signature-assist": {
      padding: "4px 8px",
      pointerEvents: "none",
      maxWidth: "min(64ch, 90vw)",
      overflowWrap: "anywhere",
    },
    "&:not(.cm-focused) .cm-signature-assist": { visibility: "hidden" },
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
