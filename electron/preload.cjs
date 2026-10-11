const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', Object.freeze({
  listPoses: () => ipcRenderer.invoke('poses:list'),
  savePose: pose => ipcRenderer.invoke('poses:save', pose),
  deletePose: id => ipcRenderer.invoke('poses:delete', id),
  savePNG: request => ipcRenderer.invoke('file:png', request),
  exportPose: pose => ipcRenderer.invoke('file:export-pose', pose),
  importPose: () => ipcRenderer.invoke('file:import-pose'),
}));
