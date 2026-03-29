/**
 * Renzo AI — Electron main process.
 *
 * Responsibilities:
 * - Launch BrowserWindow pointing at the backend-served renderer
 * - Set up IPC handlers for E2EE operations
 * - Manage offline sync and staff tracker
 * - Handle app lifecycle events
 */
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeTheme } = require('electron');
const path   = require('path');
const fs     = require('fs');
const isDev  = !app.isPackaged;

// ── Load env ─────────────────────────────────────────────────────────────────
if (isDev) {
  try { require('dotenv').config({ path: path.join(__dirname, '../../../backend/.env') }); } catch {}
}

// ── Services ──────────────────────────────────────────────────────────────────
const e2ee        = require('../e2ee/index');
const offlineSync = require('../../services/offlineSync');
const staffTracker = require('../../services/staffTracker');

let mainWindow = null;
let tray       = null;

// ── Window factory ────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:          1280,
    height:         820,
    minWidth:       900,
    minHeight:      600,
    titleBarStyle:  'hiddenInset',
    vibrancy:       'under-window',
    backgroundColor: '#0d0d0e',
    show: false,
    webPreferences: {
      preload:          path.join(__dirname, '../preload/index.js'),
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox:          true,
      webSecurity:      true,
    },
  });

  const backendUrl = process.env.BACKEND_URL || 'http://localhost:3001';
  const rendererPath = isDev
    ? path.join(__dirname, '../renderer/app.html')
    : path.join(__dirname, '../renderer/app.html');

  if (fs.existsSync(rendererPath)) {
    mainWindow.loadFile(rendererPath);
  } else {
    // Fall back to loading from backend if renderer is separate
    mainWindow.loadURL(`${backendUrl}/app`);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Intercept external links — open in browser, not in Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ── IPC: Auth / Token ─────────────────────────────────────────────────────────
ipcMain.handle('auth:setToken', async (_, token) => {
  await e2ee.init();
  return true;
});

ipcMain.handle('auth:getToken', async () => {
  // Tokens are stored in the renderer via localStorage; IPC just relays
  return null;
});

// ── IPC: E2EE ─────────────────────────────────────────────────────────────────
ipcMain.handle('e2ee:getPublicKeys', async () => {
  try {
    const keys = await e2ee.getPublicKeys();
    return keys;
  } catch { return null; }
});

ipcMain.handle('e2ee:encryptForAdmin', async (_, data, adminPublicKey) => {
  return e2ee.encryptForAdmin(data, adminPublicKey);
});

ipcMain.handle('e2ee:decryptFromSender', async (_, encryptedData, senderPublicKey) => {
  return e2ee.decryptFromSender(encryptedData, senderPublicKey);
});

ipcMain.handle('e2ee:signReport', async (_, data) => {
  return e2ee.signReport(data);
});

ipcMain.handle('e2ee:verifyReport', async (_, data, signature, signingPublicKey) => {
  return e2ee.verifyReport(data, signature, signingPublicKey);
});

ipcMain.handle('e2ee:generateAndRegisterKeys', async (_, userId) => {
  return e2ee.generateAndRegisterKeys(userId);
});

// ── IPC: Staff tracker ────────────────────────────────────────────────────────
ipcMain.handle('tracker:getStatus', async () => {
  return staffTracker.getStatus();
});

ipcMain.handle('tracker:startMonitoring', async (_, workspaceId) => {
  return staffTracker.startMonitoring(workspaceId);
});

ipcMain.handle('tracker:stopMonitoring', async () => {
  return staffTracker.stopMonitoring();
});

// ── IPC: Offline sync ─────────────────────────────────────────────────────────
ipcMain.handle('sync:getOutboxCount', async () => {
  return offlineSync.getOutboxCount();
});

ipcMain.handle('sync:replayOutbox', async () => {
  return offlineSync.replayOutbox();
});

// ── IPC: Dialog ───────────────────────────────────────────────────────────────
ipcMain.handle('dialog:openFile', async (_, opts) => {
  const result = await dialog.showOpenDialog(mainWindow, opts || {
    properties: ['openFile'],
    filters: [
      { name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:saveFile', async (_, opts) => {
  const result = await dialog.showSaveDialog(mainWindow, opts || {});
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('shell:openExternal', async (_, url) => {
  shell.openExternal(url);
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // FIX: init E2EE before anything else
  try {
    await e2ee.init();
    console.log('[main] E2EE ready');
  } catch (err) {
    console.warn('[main] E2EE init skipped (keys may not be generated yet):', err.message);
  }

  // FIX: init offlineSync (starts the sync service; setInterval is only started INSIDE init())
  try {
    await offlineSync.init();
    console.log('[main] Offline sync ready');
  } catch (err) {
    console.warn('[main] Offline sync init error:', err.message);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  offlineSync.stop();
  staffTracker.stopMonitoring();
});

// Security: prevent additional renderer processes
app.on('web-contents-created', (_, contents) => {
  contents.on('will-navigate', (event, url) => {
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:3001';
    if (!url.startsWith(backendUrl) && !url.startsWith('file://')) {
      event.preventDefault();
    }
  });
});
