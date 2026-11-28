import { LINK_TEST_SCENE } from "./linkTestScene.js";

export function createAbletonLinkPlugin(link) {
  return {
    id: "ableton-link",
    name: "Ableton Link",
    setup(ctx) {
      const desktop = window.hydractrlDesktop;
      if (!link || !desktop) return;
      const anchor = ctx.getPanels().stats?.display?.section;
      const button = document.createElement("button");
      button.textContent = "Link Test Scene";
      button.hidden = true;
      const load = () => {
        if (!window.confirm("Replace the current Sketch tab with Link Test Scene?")) return;
        ctx.editor.dispatch({ changes: { insert: LINK_TEST_SCENE } });
        ctx.runCode();
      };
      button.addEventListener("click", load);
      anchor?.before(button);
      let disposed = false;
      desktop
        .getState()
        .then((state) => {
          if (!disposed) button.hidden = !state.linkAvailable;
        })
        .catch(() => {});
      return {
        api: link.api,
        dispose() {
          disposed = true;
          button.removeEventListener("click", load);
          button.remove();
          link.dispose();
        },
      };
    },
  };
}
