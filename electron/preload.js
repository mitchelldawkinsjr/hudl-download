const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFiles: () => ipcRenderer.invoke('open-files'),
  readNotes: (videoPath) => ipcRenderer.invoke('read-notes', videoPath),
  writeNotes: (videoPath, data) => ipcRenderer.invoke('write-notes', videoPath, data),
});
