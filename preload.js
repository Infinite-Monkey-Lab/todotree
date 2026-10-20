const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("todoAPI", {
  load: () => ipcRenderer.invoke("load-todo"),
  save: (request) => ipcRenderer.invoke("save-todo", request),
  saveCopy: (content) => ipcRenderer.invoke("save-copy", content),
  openBackups: () => ipcRenderer.invoke("open-backups"),
  changeFile: () => ipcRenderer.invoke("change-file"),
  getFilePath: () => ipcRenderer.invoke("get-file-path"),
  togglePin: () => ipcRenderer.invoke("toggle-pin"),
  beginTransientEdit: () => ipcRenderer.invoke("begin-transient-edit"),
  closeApp: () => ipcRenderer.invoke("close-app"),
  getAutoStart: () => ipcRenderer.invoke("get-auto-start"),
  toggleAutoStart: () => ipcRenderer.invoke("toggle-auto-start"),
  getZoneHeights: () => ipcRenderer.invoke("get-zone-heights"),
  saveZoneHeights: (h) => ipcRenderer.invoke("save-zone-heights", h),
  onPinStateChanged: (callback) =>
    ipcRenderer.on("pin-state-changed", (_e, pinned) => callback(pinned)),
  onCloseRequested: (callback) => ipcRenderer.on("close-requested", callback),
});
