'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The renderer gets exactly these three functions and nothing else --
// no Node, no filesystem, no arbitrary IPC.
contextBridge.exposeInMainWorld('pulse', {
  ready: () => ipcRenderer.invoke('pulse:ready'),
  onUpdate: (callback) => {
    ipcRenderer.on('pulse:update', (_event, snapshot) => callback(snapshot));
  },
  onError: (callback) => {
    ipcRenderer.on('pulse:error', (_event, error) => callback(error));
  }
});
