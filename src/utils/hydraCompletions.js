import { insertBracket, pickedCompletion } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { Facet } from "@codemirror/state";
import {
  globalSignature,
  memberSignature,
  parameterLabel,
} from "../client/plugins/hydraSignature.js";
import hydraData from "../data/hydra-functions.json" assert { type: "json" };
import { inJavaScriptLiteral } from "./editorDelimiters.js";

const catalog = hydraData.functions;
const catalogNames = Object.keys(catalog);
const callbacks = ["draw", "setup", "mousePressed", "mouseReleased", "mouseMoved"];
const noBinding = () => undefined;

// Signature Assist supplies its resolver and registry when the plugin is active.
export const hydraCompletionScope = Facet.define({ combine: (sources) => sources[0] });

function applyCall(view, completion, from, to) {
  const { state } = view;
  const callee = syntaxTree(state).resolveInner(to, -1);
  const expression = callee.name === "PropertyName" ? callee.parent : callee;
  const call = expression.parent;
  const opening =
    call && ["CallExpression", "NewExpression"].includes(call.name)
      ? call.getChild("ArgList")?.firstChild
      : null;
  const replaced = { from, to, insert: completion.label };
  const pickup = {
    annotations: pickedCompletion.of(completion),
    userEvent: "input.complete",
    scrollIntoView: true,
  };
  if (opening?.name === "(" && opening.from >= to) {
    const delta = completion.label.length - (to - from);
    view.dispatch({ ...pickup, changes: replaced, selection: { anchor: opening.to + delta } });
    return;
  }

  // Let CodeMirror mark the generated closer so a typed ")" skips it.
  const pair = state.selection.main.head === to ? insertBracket(state, "(") : null;
  if (pair) {
    view.dispatch(
      { changes: pair.changes, effects: pair.effects, selection: pair.selection },
      { ...pickup, changes: replaced, sequential: true },
    );
  } else {
    view.dispatch({
      ...pickup,
      changes: { ...replaced, insert: `${completion.label}()` },
      selection: { anchor: from + completion.label.length + 1 },
    });
  }
}

function optionFor(name, signature, member, value, entry) {
  if (!signature && !value) return null;
  const info =
    signature?.description ??
    (member && entry?.example
      ? `${entry.description}\n\nExample: ${entry.example}`
      : entry?.description);
  if (!signature) return { label: name, type: member ? "property" : "variable", info };
  return {
    label: name,
    type: member ? "method" : "function",
    detail: `(${signature.params.map(parameterLabel).join(", ")})`,
    info,
    apply: applyCall,
  };
}

export function hydraCompletions(context) {
  const { state, pos, explicit } = context;
  if (inJavaScriptLiteral(state, pos)) return null;
  const token = syntaxTree(state).resolveInner(pos, -1);
  if (token.name === "VariableDefinition") return null;
  const match = context.matchBefore(/[$\p{ID_Continue}\u200c\u200d]*$/u);
  const member =
    ["PropertyName", "."].includes(token.name) && token.parent?.name === "MemberExpression"
      ? token.parent
      : null;
  if (member && !member.getChild(".")) return null;
  if (!member && !match.text && !explicit) return null;

  const scope = state.facet(hydraCompletionScope);
  const lookup = scope?.resolve(state);
  if (scope && !lookup) return null;
  const custom = lookup ?? noBinding;
  const transforms = scope?.getTransforms();
  const getTransform = (name) =>
    transforms && Object.hasOwn(transforms, name) ? transforms[name] : undefined;
  const names = new Set([...catalogNames, ...Object.keys(transforms ?? {})]);
  if (!member) {
    for (const name of callbacks) names.add(name);
    if (lookup) for (const name of lookup.names()) names.add(name);
  }

  const prefix = match.text.toLowerCase();
  const receiver = member?.firstChild;
  const options = [];
  for (const name of names) {
    if (!name.toLowerCase().startsWith(prefix)) continue;
    const binding = member ? undefined : custom(name, match.from);
    const signature = member
      ? memberSignature(state, receiver, name, custom, getTransform)
      : globalSignature(name, binding, getTransform);
    const value = member
      ? name === "fft" &&
        receiver.name === "VariableName" &&
        state.sliceDoc(receiver.from, receiver.to) === "a" &&
        custom("a", receiver.from) === undefined
      : binding === undefined &&
        (catalog[name]?.syntaxType === "global" || callbacks.includes(name));
    const option = optionFor(
      name,
      signature,
      member,
      value,
      binding === undefined ? catalog[name] : undefined,
    );
    if (option) options.push(option);
  }
  if (!options.length) return null;
  const to =
    token.from === match.from && ["VariableName", "PropertyName"].includes(token.name)
      ? token.to
      : pos;
  // Visible names depend on both tab texts and the cursor's declaration scope.
  return { from: match.from, to, options };
}
