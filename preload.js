const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cellarBrew", {
  diagnose: () => ipcRenderer.invoke("brew:diagnose"),
  installed: () => ipcRenderer.invoke("brew:installed"),
  outdated: () => ipcRenderer.invoke("brew:outdated"),
  install: (packageInfo) => ipcRenderer.invoke("brew:install", packageInfo),
  uninstall: (packageInfo) => ipcRenderer.invoke("brew:uninstall", packageInfo),
  upgrade: (packageInfo) => ipcRenderer.invoke("brew:upgrade", packageInfo),
  upgradeAll: () => ipcRenderer.invoke("brew:upgrade-all"),
  doctor: () => ipcRenderer.invoke("brew:doctor"),
  openLink: (url) => ipcRenderer.invoke("link:open", url)
});
