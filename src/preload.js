const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("htv", {
  platform: process.platform,
  getStreams: () => ipcRenderer.invoke("htv:get-streams"),
  refresh: () => ipcRenderer.invoke("htv:refresh"),
  extract: (link, opts) => ipcRenderer.invoke("htv:extract", link, opts),
  markFailed: link => ipcRenderer.invoke("htv:mark-failed", link),
  onLinkStatus: fn => ipcRenderer.on("htv:link-status", (_e, s) => fn(s)),
  onStreams: fn => ipcRenderer.on("htv:streams", (_e, d) => fn(d)),
  openExternal: link => ipcRenderer.invoke("htv:open-external", link),
  gameStats: gameName => ipcRenderer.invoke("htv:game-stats", gameName),
  gameLabels: names => ipcRenderer.invoke("htv:game-labels", names),
  onRefreshShortcut: fn => ipcRenderer.on("htv:refresh-shortcut", () => fn()),
  getSettings: () => ipcRenderer.invoke("htv:get-settings"),
  setSettings: s => ipcRenderer.invoke("htv:set-settings", s),
});
