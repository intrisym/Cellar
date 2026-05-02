const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cellarBrew", {
  diagnose: () => ipcRenderer.invoke("brew:diagnose"),
  installed: () => ipcRenderer.invoke("brew:installed"),
  outdated: () => ipcRenderer.invoke("brew:outdated"),
  install: (packageInfo) => ipcRenderer.invoke("brew:install", packageInfo),
  uninstall: (packageInfo) => ipcRenderer.invoke("brew:uninstall", packageInfo),
  upgrade: (packageInfo) => ipcRenderer.invoke("brew:upgrade", packageInfo),
  upgradeAll: (operationInfo) => ipcRenderer.invoke("brew:upgrade-all", operationInfo),
  doctor: () => ipcRenderer.invoke("brew:doctor"),
  openLink: (url) => ipcRenderer.invoke("link:open", url),
  onOperationProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("brew:operation-progress", listener);
    return () => ipcRenderer.removeListener("brew:operation-progress", listener);
  }
});
