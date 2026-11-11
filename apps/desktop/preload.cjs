const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mazzDesktop', {
  onStatus: (callback) => {
    const listener = (_event, text) => callback(String(text));
    ipcRenderer.on('desktop-status', listener);
    return () => ipcRenderer.removeListener('desktop-status', listener);
  },
  openLogs: () => ipcRenderer.invoke('desktop-open-logs'),
  quit: () => ipcRenderer.invoke('desktop-quit'),
});
