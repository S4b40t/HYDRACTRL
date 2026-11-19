import { javascript } from "@codemirror/lang-javascript";
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";

const parser = javascript().language.parser;
const functionScopes = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunction",
  "MethodDeclaration",
]);

function nextToken(node) {
  let next = node.nextSibling;
  while (next?.name === "LineComment" || next?.name === "BlockComment") next = next.nextSibling;
  return next;
}

function parameterList(source, fn) {
  if (fn.name !== "ArrowFunction" && fn.getChild("Block")?.lastChild?.name !== "}") return null;
  const list = fn.getChild("ParamList");
  if (!list || fn.getChildren("⚠").length) return null;
  if (list.firstChild?.name !== "(") {
    const binding = list.firstChild;
    return binding?.name === "VariableDefinition" && !binding.nextSibling
      ? [{ name: source.slice(binding.from, binding.to) }]
      : null;
  }
  if (list.lastChild?.name !== ")") return null;

  let invalid = false;
  list.toTree().iterate({
    enter: (node) => {
      if (node.type.isError) invalid = true;
    },
  });
  if (invalid) return null;

  const params = [];
  let start = list.firstChild.to;
  let binding = null;
  let rest = false;
  for (let part = list.firstChild.nextSibling; part; part = part.nextSibling) {
    if (part.name === ",") {
      if (!binding || rest) return null;
      params.push({ name: source.slice(start, part.from).trim() });
      binding = null;
      start = part.to;
    } else if (part.name === ")") {
      if (binding) params.push({ name: source.slice(start, part.from).trim(), rest });
      else if (rest) return null;
    } else {
      if (part.name === "Spread") rest = true;
      if (rest && part.name === "Equals") return null;
      if (["VariableDefinition", "ObjectPattern", "ArrayPattern"].includes(part.name))
        binding = part;
    }
  }
  return params;
}

function indexCustomSignatures(source, tree) {
  const bindings = new Map();
  const topLevelNames = new Set();
  const nested = new Map();

  function record(binding, signature) {
    const name = source.slice(binding.from, binding.to);
    topLevelNames.add(binding.from);
    bindings.set(name, bindings.has(name) ? null : signature);
  }

  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === "FunctionDeclaration" || node.name === "ClassDeclaration") {
      const binding = node.getChild("VariableDefinition");
      if (binding) {
        const params = node.name === "FunctionDeclaration" ? parameterList(source, node) : null;
        record(binding, params && { params, from: 0 });
      }
    } else if (node.name === "VariableDeclaration") {
      for (let part = node.firstChild; part; part = part.nextSibling) {
        if (part.name !== "VariableDefinition") continue;
        const equals = nextToken(part);
        const value = equals?.name === "Equals" ? nextToken(equals) : null;
        const params =
          value && ["FunctionExpression", "ArrowFunction"].includes(value.name)
            ? parameterList(source, value)
            : null;
        record(part, params && { params, from: value.to });
      }
    }
  }

  function block(node) {
    bindings.set(source.slice(node.from, node.to), null);
  }

  // Use the enclosing function as a conservative boundary for nested bindings.
  // Block-level visibility and assignment flow are outside the index's scope.
  function shadow(binding) {
    let scope = binding.parent;
    if (scope?.name === "FunctionDeclaration") scope = scope.parent;
    while (scope && !functionScopes.has(scope.name)) {
      if (scope.name === "AssignmentExpression") {
        block(binding);
        return;
      }
      scope = scope.parent;
    }
    if (!scope) {
      block(binding);
      return;
    }
    const name = source.slice(binding.from, binding.to);
    if (!nested.has(name)) nested.set(name, []);
    nested.get(name).push({ from: scope.from, to: scope.to });
  }

  tree.iterate({
    enter(ref) {
      switch (ref.name) {
        case "VariableDefinition":
          if (!topLevelNames.has(ref.from)) shadow(ref.node);
          break;
        case "PatternProperty": {
          const node = ref.node;
          if (node.firstChild?.name === "PropertyName" && !node.getChild(":"))
            shadow(node.firstChild);
          break;
        }
        case "AssignmentExpression": {
          const target = ref.node.firstChild;
          if (target?.name === "VariableName") block(target);
          break;
        }
        case "PostfixExpression":
        case "UnaryExpression": {
          const node = ref.node;
          const operator = node.getChild("ArithOp");
          const target = node.getChild("VariableName");
          if (
            operator &&
            target &&
            ["++", "--"].includes(source.slice(operator.from, operator.to))
          ) {
            block(target);
          }
          break;
        }
      }
    },
  });
  return { bindings, nested };
}

/** Return undefined for an unclaimed name, null for a blocked name, or parameters. */
export function createCustomSignatureResolver(editor) {
  const cache = new Map();
  let activeDoc;
  let activeTree;

  return (state) => {
    if (!syntaxTreeAvailable(state)) return null;
    const tab = editor.getCurrentTab();
    const other = tab === "setup" ? "main" : "setup";
    const tree = syntaxTree(state);
    if (tree.length !== state.doc.length) return null;

    if (state.doc !== activeDoc || tree !== activeTree) {
      const source = state.doc.toString();
      if (cache.get(tab)?.source !== source) {
        cache.set(tab, { source, ...indexCustomSignatures(source, tree) });
      }
      activeDoc = state.doc;
      activeTree = tree;
    }
    const source = editor.getTabCode(other);
    if (cache.get(other)?.source !== source) {
      cache.set(other, { source, ...indexCustomSignatures(source, parser.parse(source)) });
    }

    const { bindings: current, nested } = cache.get(tab);
    const inactive = cache.get(other).bindings;
    return (name, position) => {
      if (nested.get(name)?.some(({ from, to }) => from <= position && position < to)) return null;
      if (current.has(name) && inactive.has(name)) return null;
      if (current.has(name)) {
        const signature = current.get(name);
        return signature && signature.from <= position ? signature.params : null;
      }
      const signature = inactive.get(name);
      if (signature === undefined) return undefined;
      return signature && (tab === "main" || signature.from === 0) ? signature.params : null;
    };
  };
}
