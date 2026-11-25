import { expect, test } from "bun:test";
import { LINK_IPC, linkSenderRole, registerLinkIpc } from "./linkIpc.js";

function sender(url) {
  const mainFrame = { url };
  return { sender: { mainFrame }, senderFrame: mainFrame };
}

test("accepts only current desktop windows at their exact routes and origin", () => {
  const serverUrl = "http://127.0.0.1:13000";
  const settingsUrl = "file:///C:/App/settings.html";
  const editor = sender(`${serverUrl}/app#sketch=abc`);
  const primary = sender(`${serverUrl}/output?primary`);
  const settings = sender(`${settingsUrl}#link`);
  const windows = {
    editor: editor.sender,
    primary: primary.sender,
    settings: settings.sender,
    serverUrl,
    settingsUrl,
  };
  expect(linkSenderRole(editor, windows)).toBe("editor");
  expect(linkSenderRole(primary, windows)).toBe("primary");
  primary.senderFrame.url = serverUrl + "/output?primary&alpha";
  expect(linkSenderRole(primary, windows)).toBe("primary");
  primary.senderFrame.url = serverUrl + "/output?primary&unexpected";
  expect(linkSenderRole(primary, windows)).toBeNull();
  expect(linkSenderRole(settings, windows)).toBe("settings");
  expect(linkSenderRole(sender(`${serverUrl}/output?primary`), windows)).toBeNull();
  expect(linkSenderRole({ ...editor, senderFrame: { url: serverUrl } }, windows)).toBeNull();
  primary.senderFrame.url = "http://127.0.0.1:13001/output?primary";
  expect(linkSenderRole(primary, windows)).toBeNull();
  primary.senderFrame.url = `${serverUrl}/output`;
  expect(linkSenderRole(primary, windows)).toBeNull();
});

test("the renderer bridge cannot change settings or copy diagnostics", () => {
  const serverUrl = "http://127.0.0.1:13000";
  const editor = sender(serverUrl);
  const settingsUrl = "file:///settings.html";
  const settings = sender(settingsUrl);
  const handlers = new Map();
  registerLinkIpc({
    ipcMain: { handle: (key, handler) => handlers.set(key, handler) },
    getWindows: () => ({
      editor: editor.sender,
      settings: settings.sender,
      serverUrl,
      settingsUrl,
    }),
    service: { snapshot: () => "timing", diagnostics: () => "diagnostics" },
    configure: () => "configured",
  });
  expect(handlers.get(LINK_IPC.snapshot)(editor)).toBe("timing");
  expect(handlers.get(LINK_IPC.snapshot)(settings)).toBeNull();
  expect(handlers.get(LINK_IPC.diagnostics)(settings)).toBe("diagnostics");
  expect(handlers.get(LINK_IPC.configure)(editor)).toBeNull();
  expect(handlers.get(LINK_IPC.copyDiagnostics)(editor)).toBe(false);
});
