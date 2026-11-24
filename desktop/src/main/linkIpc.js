export const LINK_IPC = Object.freeze({
  snapshot: "link:snapshot",
  diagnostics: "link:diagnostics",
  configure: "link:configure",
  copyDiagnostics: "link:copy-diagnostics",
});

export function linkSenderRole(event, { editor, primary, settings, serverUrl, settingsUrl }) {
  const { sender, senderFrame } = event;
  if (!senderFrame || senderFrame !== sender?.mainFrame) return null;
  try {
    const page = new URL(senderFrame.url);
    if (sender === settings) {
      page.hash = "";
      return page.href === settingsUrl ? "settings" : null;
    }
    if (!serverUrl || page.origin !== new URL(serverUrl).origin) return null;
    if (sender === editor && ["/", "/app"].includes(page.pathname)) return "editor";
    if (sender === primary && page.pathname === "/output" && page.search === "?primary") {
      return "primary";
    }
  } catch (_error) {
    // Destroyed or navigating windows can have no usable URL.
  }
  return null;
}

export function registerLinkIpc({ ipcMain, getWindows, service, configure, clipboard, appInfo }) {
  const role = (event) => linkSenderRole(event, getWindows());
  ipcMain.handle(LINK_IPC.snapshot, (event) => {
    const caller = role(event);
    return caller === "editor" || caller === "primary" ? service.snapshot() : null;
  });
  ipcMain.handle(LINK_IPC.diagnostics, (event) =>
    role(event) === "settings" ? service.diagnostics() : null,
  );
  ipcMain.handle(LINK_IPC.configure, (event, link) =>
    role(event) === "settings" ? configure(link) : null,
  );
  ipcMain.handle(LINK_IPC.copyDiagnostics, (event) => {
    if (role(event) !== "settings") return false;
    const {
      state,
      enabled,
      available,
      helper,
      peers,
      anchor,
      error,
      lastSampleAgeMs,
      roundTripMs,
      tempoRevision,
    } = service.diagnostics();
    clipboard.writeText(
      JSON.stringify(
        {
          ...appInfo(),
          state,
          enabled,
          available,
          helper,
          peers,
          bpm: anchor.bpm,
          quantum: anchor.quantum,
          error,
          lastSampleAgeMs,
          roundTripMs,
          tempoRevision,
        },
        null,
        2,
      ),
    );
    return true;
  });
}
