const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bevPrompt", {
  submit: (value) => ipcRenderer.send("prompt:submit", value),
  cancel: () => ipcRenderer.send("prompt:cancel"),
});
