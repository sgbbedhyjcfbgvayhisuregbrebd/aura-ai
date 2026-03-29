/**
 * Preload — exposes a safe contextBridge API to the renderer.
 * All main-process capabilities are bridged here.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── E2EE ──────────────────────────────────────────────────────────────────
  e2ee: {
    getPublicKeys:           ()         => ipcRenderer.invoke('e2ee:getPublicKeys'),
    encryptForAdmin:         (data, pk) => ipcRenderer.invoke('e2ee:encryptForAdmin', data, pk),
    decryptFromSender:       (enc, spk) => ipcRenderer.invoke('e2ee:decryptFromSender', enc, spk),
    signReport:              (data)     => ipcRenderer.invoke('e2ee:signReport', data),
    verifyReport:            (d, s, pk) => ipcRenderer.invoke('e2ee:verifyReport', d, s, pk),
    generateAndRegisterKeys: (userId)   => ipcRenderer.invoke('e2ee:generateAndRegisterKeys', userId),
  },

  // ── Auth ──────────────────────────────────────────────────────────────────
  auth: {
    setToken: (token) => ipcRenderer.invoke('auth:setToken', token),
    getToken: ()      => ipcRenderer.invoke('auth:getToken'),
  },

  // ── Staff tracker ─────────────────────────────────────────────────────────
  tracker: {
    getStatus:       ()            => ipcRenderer.invoke('tracker:getStatus'),
    startMonitoring: (workspaceId) => ipcRenderer.invoke('tracker:startMonitoring', workspaceId),
    stopMonitoring:  ()            => ipcRenderer.invoke('tracker:stopMonitoring'),
  },

  // ── Offline sync ──────────────────────────────────────────────────────────
  sync: {
    getOutboxCount: () => ipcRenderer.invoke('sync:getOutboxCount'),
    replayOutbox:   () => ipcRenderer.invoke('sync:replayOutbox'),
  },

  // ── Native dialogs ────────────────────────────────────────────────────────
  dialog: {
    openFile: (opts) => ipcRenderer.invoke('dialog:openFile', opts),
    saveFile: (opts) => ipcRenderer.invoke('dialog:saveFile', opts),
  },

  // ── Shell ─────────────────────────────────────────────────────────────────
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },

  // ── Platform info ─────────────────────────────────────────────────────────
  platform: process.platform,
  isDev: !require('@electron/remote')?.app?.isPackaged ?? process.env.NODE_ENV === 'development',
});
