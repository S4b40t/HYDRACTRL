/**
 * CodeMirror editor for Hydra code
 * Uses CodeMirror 6 with JavaScript mode for syntax highlighting
 */

import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyField,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { monokai } from "@uiw/codemirror-theme-monokai";
import { solarizedDark } from "@uiw/codemirror-theme-solarized";
import { editorDelimiters } from "./editorDelimiters.js";
import { createEditorExtensions } from "./editorExtensions.js";
import { insertLines } from "./editorInsert.js";
import { lightEditorTheme, popEditorTheme } from "./editorThemes.js";
import { hydraCompletions } from "./hydraCompletions.js";
import { flashCode, runFlash } from "./runFlash.js";

// Language compartment for JavaScript with Hydra extensions
const languageCompartment = new Compartment();

// Create a compartment for theme extensions to allow dynamic switching
const themeCompartment = new Compartment();

// Map UI themes to CodeMirror themes
const themeMapping = {
  // Default (no theme class) uses oneDark (Dracula-inspired)
  default: oneDark,

  // Light theme
  "theme-light": lightEditorTheme,

  // Dark theme (high contrast)
  "theme-dark": solarizedDark,

  // Neon Eighties theme
  "theme-neon-eighties": monokai,

  // Nineties Pop theme
  "theme-nineties-pop": popEditorTheme,
};

// Create a minimal base theme for the editor. Code is set in Fira Code
// (styles.css loads it), ligatures included.
const hydraTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "14px",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-code)",
    lineHeight: "1.5",
  },
  ".cm-content": {
    padding: "2px 0",
  },
  ".cm-gutters": {
    backgroundColor: "var(--color-bg-editor)",
    border: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 2px 0 6px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-code)",
  },
  ".cm-tooltip": {
    fontFamily: "var(--font-ui)",
    fontSize: "12px",
  },
});

// Set on the editor while files are dragged over it (styles.css)
const FILE_DROP_CLASS = "cm-file-drop-target";

function hasFiles(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * Hand files dropped anywhere on the editor, gutter included, to
 * `handler({ files, pos })`, with the document position under the pointer.
 * The listeners capture the events before CodeMirror sees them, and
 * CodeMirror leaves handled events alone, so it doesn't paste the files' text.
 * Returns a function that stops it.
 */
function watchFileDrops(view, handler) {
  const target = view.dom;
  let clearTimer = null;
  const unmark = () => {
    clearTimeout(clearTimer);
    target.classList.remove(FILE_DROP_CLASS);
  };
  const onDragOver = (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    target.classList.add(FILE_DROP_CLASS);
    // dragleave also fires between the editor's own elements, so the mark
    // goes once the dragover events stop
    clearTimeout(clearTimer);
    clearTimer = setTimeout(unmark, 150);
  };
  const onDrop = (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    unmark();
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    handler({ files: Array.from(event.dataTransfer.files), pos });
  };
  target.addEventListener("dragover", onDragOver, true);
  target.addEventListener("drop", onDrop, true);
  return () => {
    unmark();
    target.removeEventListener("dragover", onDragOver, true);
    target.removeEventListener("drop", onDrop, true);
  };
}

/**
 * Create a CodeMirror editor for Hydra code
 * @param {HTMLElement} container - Container to add the editor to
 * @param {string} initialCode - Initial code to display
 * @returns {Object} Editor object with API methods
 */
export function createCodeMirrorEditor(container, initialCode = "") {
  // Called whenever the code or the cursor changes (see onUpdate below)
  const updateListeners = new Set();
  const notifyUpdates = EditorView.updateListener.of((update) => {
    if (!update.docChanged && !update.selectionSet) return;
    for (const listener of updateListeners) {
      try {
        listener();
      } catch (error) {
        console.error("Editor update listener failed:", error);
      }
    }
  });

  // Custom key handler for Ctrl+Enter
  // We need to use a combination of approaches to ensure it's captured

  // Direct DOM event handler
  const preventCtrlEnterHandler = EditorView.domEventHandlers({
    keydown: (event, view) => {
      // Check for Ctrl+Enter or Cmd+Enter (code 13 is Enter)
      if ((event.ctrlKey || event.metaKey) && (event.key === "Enter" || event.keyCode === 13)) {
        // Prevent default behavior (adding newline)
        event.preventDefault();
        event.stopPropagation();
        // The actual run code action is handled by the global event listener in client/index.js
        return true;
      }
      return false;
    },
  });

  // Custom keymap that takes priority over the default keymap
  const ctrlEnterKeymap = keymap.of([
    {
      key: "Ctrl-Enter",
      mac: "Cmd-Enter",
      run: () => {
        // Returning true means the key was handled
        return true;
      },
      // High priority to override other keymaps
      preventDefault: true,
    },
    {
      // Add Ctrl+Space for manual trigger of completion
      key: "Ctrl-Space",
      mac: "Cmd-Space",
      run: startCompletion,
    },
  ]);

  // Function to get the appropriate theme based on body class
  function getCurrentTheme() {
    // Check if any theme classes are present on the body
    const bodyClasses = document.body.className.split(" ");
    for (const className of bodyClasses) {
      if (themeMapping[className]) {
        return themeMapping[className];
      }
    }
    // Default to the default theme if no matching class is found
    return themeMapping.default;
  }

  const pluginExtensions = createEditorExtensions((spec) => view.dispatch(spec));
  const tabHistory = new Map();
  const historyCompartment = new Compartment();

  // Create initial editor state
  const startState = EditorState.create({
    doc: initialCode,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      // Our custom Ctrl+Enter keymap comes first for highest priority
      ctrlEnterKeymap,
      history(),
      historyCompartment.of([]),
      editorDelimiters,
      EditorView.domEventObservers({
        keydown(event, view) {
          // A completion keymap can consume Escape before CodeMirror's fallback runs.
          if (event.key === "Escape") view.setTabFocusMode(2000);
        },
      }),
      keymap.of([
        { key: "Tab", run: acceptCompletion },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      languageCompartment.of(javascript()),
      hydraTheme, // Base editor styling
      themeCompartment.of(getCurrentTheme()), // Theme-specific syntax coloring
      EditorView.lineWrapping,
      EditorState.tabSize.of(2),
      runFlash(), // The code lights up for a moment when it runs
      notifyUpdates,
      pluginExtensions.extension,
      preventCtrlEnterHandler, // Add our custom handler
      // Add autocompletion with custom Hydra completions
      autocompletion({
        override: [hydraCompletions],
        activateOnTyping: true,
        defaultKeymap: true,
        interactionDelay: 0,
        icons: true,
        closeOnBlur: true,
      }),
    ],
  });

  // Create the editor view
  const view = new EditorView({
    state: startState,
    parent: container,
  });
  const emptyHistory = startState.field(historyField);

  // Add custom class for additional styling
  view.dom.classList.add("cm-editor");

  // Set up theme change observer
  const themeObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.attributeName === "class") {
        // Body class has changed, check if we need to update the theme
        const newTheme = getCurrentTheme();
        view.dispatch({
          effects: themeCompartment.reconfigure(newTheme),
        });
      }
    }
  });

  // Start observing the body element for class changes
  themeObserver.observe(document.body, { attributes: true });

  // Create an object to simplify the integration
  const editor = {
    getCode: () => view.state.doc.toString(),
    setCode: (code) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: code },
      });
    },
    switchTab: (from, to, code) => {
      closeCompletion(view);
      tabHistory.set(from, view.state.field(historyField));
      const incomingHistory = tabHistory.get(to) ?? emptyHistory;

      // Load the document before restoring its history so CodeMirror never
      // maps the incoming tab's undo and redo positions through the swap.
      const changeDocument = view.state.update({
        changes: { from: 0, to: view.state.doc.length, insert: code },
        annotations: Transaction.addToHistory.of(false),
      });
      const restoreHistory = changeDocument.state.update({
        effects: historyCompartment.reconfigure(historyField.init(() => incomingHistory)),
      });
      view.dispatch([changeDocument, restoreHistory]);
    },
    focus: () => view.focus(),
    addExtension: pluginExtensions.addExtension,
    // The cursor, as offsets into the code: { anchor, head }
    getSelection: () => {
      const { anchor, head } = view.state.selection.main;
      return { anchor, head };
    },
    // Call `listener` whenever the code or the cursor changes. Returns a
    // function that stops it.
    onUpdate: (listener) => {
      updateListeners.add(listener);
      return () => updateListeners.delete(listener);
    },
    // Light the code up for a moment, to show it ran (not with reduced motion)
    flash: () => {
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
      flashCode(view);
    },
    element: view.dom,
    // Take files dropped on the editor instead of pasting them (the desktop
    // app's media drops). Returns a function that stops it.
    handleFileDrops: (handler) => watchFileDrops(view, handler),
    // Put lines of code near `pos`, where they don't split a statement
    insertLines: (pos, lines) => view.dispatch(insertLines(view.state, pos, lines)),
    // Add method to manually update theme
    updateTheme: () => {
      const newTheme = getCurrentTheme();
      view.dispatch({
        effects: themeCompartment.reconfigure(newTheme),
      });
    },
  };

  return editor;
}
