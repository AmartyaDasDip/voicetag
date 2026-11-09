// VoiceTag – safe bridge between the window and the computer
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  isDesktop: true,
  openVideo: () => ipcRenderer.invoke('open-video'),
  registerMedia: p => ipcRenderer.invoke('register-media', p),
  pathForFile: file => { try { return webUtils.getPathForFile(file); } catch (e) { return ''; } },
  mediaUrl: p => 'app://voicetag/__media?p=' + encodeURIComponent(p),
  saveFile: opts => ipcRenderer.invoke('save-file', opts),
  openTextFile: opts => ipcRenderer.invoke('open-text-file', opts),
  modelInfo: () => ipcRenderer.invoke('model-info'),
  ffmpegInfo: () => ipcRenderer.invoke('ffmpeg-info'),
  showInFolder: p => ipcRenderer.invoke('show-in-folder', p),
  exportClips: opts => ipcRenderer.invoke('export-clips', opts),
  cancelExport: () => ipcRenderer.invoke('cancel-export'),
  onExportProgress: cb => ipcRenderer.on('export-progress', (e, p) => cb(p)),
  convertVideo: p => ipcRenderer.invoke('convert-video', p),
  cachedConversion: p => ipcRenderer.invoke('cached-conversion', p),
  cancelConvert: () => ipcRenderer.invoke('cancel-convert'),
  onConvertProgress: cb => ipcRenderer.on('convert-progress', (e, p) => cb(p)),
  onClosing: cb => ipcRenderer.on('app-closing', () => cb())
});
