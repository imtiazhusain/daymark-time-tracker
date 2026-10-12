'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel, ...args) => ipcRenderer.invoke(`tracker:${channel}`, ...args);
contextBridge.exposeInMainWorld('trackerAPI', Object.freeze({
  status: () => invoke('status'),
  monthHistory: month => invoke('month-history', month),
  selectUser: id => invoke('select', id),
  seedUsers: () => invoke('seed'),
  start: () => invoke('start'),
  pause: () => invoke('pause'),
  stop: () => invoke('stop'),
  connect: uri => invoke('connect', uri),
  savePreferences: settings => invoke('preferences', settings),
  preview: () => invoke('preview'),
  openDataFolder: () => invoke('open-data'),
  openScreenshotFolder: () => invoke('open-shots'),
  onUpdate: handler => {
  const listener = (_event, data) => handler(data);
  ipcRenderer.on('tracker:update', listener);
  return () => ipcRenderer.removeListener('tracker:update', listener);
},

onScreenshotSound: handler => {
  const listener = () => handler();

  ipcRenderer.on('tracker:soft-sound', listener);

  return () =>
    ipcRenderer.removeListener('tracker:soft-sound', listener);
}
}));
