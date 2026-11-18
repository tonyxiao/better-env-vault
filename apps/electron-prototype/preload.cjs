const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("prototype", {
  probe: (account) => ipcRenderer.invoke("prototype:probe", account),
});
