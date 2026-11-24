const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hydractrlLinkTiming", {
  snapshot: () => ipcRenderer.invoke("link:snapshot"),
});
