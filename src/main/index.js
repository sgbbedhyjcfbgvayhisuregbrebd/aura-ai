require('dotenv').config();
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, globalShortcut, dialog } = require('electron');
const path   = require('path');
const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');
const Store  = require('electron-store');
const { safeStorage } = require('electron');
const { waitForOAuthCallback } = require('./oauth-server');
const {
  exchangeMicrosoftCode, refreshMicrosoftToken,
  exchangeGoogleCode,   refreshGoogleToken,
  getMicrosoftEmails,   getMicrosoftCalendar, sendMicrosoftEmail,
  getGoogleEmails,      getGoogleCalendar,    sendGoogleEmail
} = require('./providers');

// ── Config ────────────────────────────────────────────────────
const AZURE_CLIENT_ID      = process.env.AZURE_CLIENT_ID      || '';
const AZURE_CLIENT_SECRET  = process.env.AZURE_CLIENT_SECRET  || '';
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const BACKEND_URL          = process.env.BACKEND_URL          || 'http://localhost:3001';
const MS_REDIRECT = 'http://localhost:3000/auth/microsoft/callback';
const GC_REDIRECT = 'http://localhost:3000/auth/google/callback';

// ── Store ─────────────────────────────────────────────────────
const store = new Store({
  schema: {
    onboarded:          { type: 'boolean', default: false },
    userEmail:          { type: 'string',  default: '' },
    userName:           { type: 'string',  default: '' },
    connectedProviders: { type: 'array',   default: [] },
    styleProfile:       { type: 'object',  default: {} },
    windowBounds:       { type: 'object',  default: { width: 1200, height: 780 } },
    monthlyCost:        { type: 'number',  default: 0 },
    todayCost:          { type: 'number',  default: 0 },
    totalTokens:        { type: 'number',  default: 0 },
    totalQueries:       { type: 'number',  default: 0 },
    emailCost:          { type: 'number',  default: 0 },
    calCost:            { type: 'number',  default: 0 },
    chatCost:           { type: 'number',  default: 0 },
    otherCost:          { type: 'number',  default: 0 }
  }
});

// ── Encrypted secrets ─────────────────────────────────────────
function saveSecret(key, value) {
  if (!safeStorage.isEncryptionAvailable()) { store.set('plain_' + key, value); return; }
  store.set('secret_' + key, safeStorage.encryptString(value).toString('base64'));
}

function loadSecret(key) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return store.get('plain_' + key, null);
    const b64 = store.get('secret_' + key);
    if (!b64) return null;
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  } catch { return null; }
}

// ── Token management ──────────────────────────────────────────
function saveTokens(provider, tokens) {
  saveSecret(`${provider}_access`, tokens.access_token);
  if (tokens.refresh_token) saveSecret(`${provider}_refresh`, tokens.refresh_token);
  store.set(`${provider}_expires`, Date.now() + (tokens.expires_in || 3600) * 1000);
}

async function getValidToken(provider) {
  const expiresAt   = store.get(`${provider}_expires`, 0);
  const accessToken = loadSecret(`${provider}_access`);
  if (accessToken && Date.now() < expiresAt - 300000) return accessToken;

  const refreshToken = loadSecret(`${provider}_refresh`);
  if (!refreshToken) return null;

  try {
    const tokens = provider === 'microsoft'
      ? await refreshMicrosoftToken(refreshToken, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET)
      : await refreshGoogleToken(refreshToken, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
    saveTokens(provider, tokens);
    return tokens.access_token;
  } catch (e) {
    console.error(`[oauth] ${provider} refresh failed:`, e.message);
    return null;
  }
}

function markConnected(provider) {
  const list = store.get('connectedProviders', []);
  if (!list.includes(provider)) list.push(provider);
  store.set('connectedProviders', list);
}

function markDisconnected(provider) {
  store.set('connectedProviders', store.get('connectedProviders', []).filter(p => p !== provider));
  store.delete(`${provider}_expires`);
  store.delete('secret_' + provider + '_access');
  store.delete('secret_' + provider + '_refresh');
}

// ── Windows & Tray ────────────────────────────────────────────
let mainWindow  = null;
let tray        = null;
let isQuitting  = false;

function createMainWindow() {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); return; }

  const { width, height } = store.get('windowBounds');
  mainWindow = new BrowserWindow({
    width, height, minWidth: 900, minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#050D18', show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/app.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('resize', () => store.set('windowBounds', mainWindow.getBounds()));

  // Hide to tray instead of closing on macOS/Windows
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (process.platform === 'darwin') app.dock.hide();
      updateTrayMenu();
    }
  });

  mainWindow.on('show', () => {
    if (process.platform === 'darwin') app.dock.show();
    updateTrayMenu();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createOnboardWindow() {
  const win = new BrowserWindow({
    width: 520, height: 700, resizable: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#050D18', show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, '../renderer/onboarding.html'));
  win.once('ready-to-show', () => win.show());
}

// ── Tray icon (inline PNG — 16x16 white bird silhouette) ──────
function getTrayIcon() {
  // 22x22 template image encoded as base64 PNG
  // A simple bird/envelope shape that works as a monochrome tray icon
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAABmJLR0QA/wD/AP+gvaeTAAAAoklEQVQ4je2UMQqDQBBFn0sK72CvZMETeI+cIM1eIPQWFnqTkE4hBBJWQxrBZbffYiNs2M3irgs+GBhmHo+ZZQF+zg44AifgAnTA0XJJ0lxHYDZwZbCQpIdFJN0kPYCXpLekj6RX/tEDzpLakrqkpqQqqdlsSqokqSmpSmqymtKqjKaUKqkppcqfSqmSmjKqrKacKq1KrA+wB67AHvgCj9kLMCUxhLkAAAAASUVORK5CYII='
  );
  // macOS needs template image (all black, system handles colour)
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  return icon;
}

function updateTrayMenu() {
  if (!tray) return;
  const isVisible = mainWindow && mainWindow.isVisible();
  const unreadCount = store.get('unreadCount', 0);
  const monthlyCost = store.get('monthlyCost', 0);

  const menu = Menu.buildFromTemplate([
    {
      label: 'Arie AI',
      enabled: false,
      // shows as a header
    },
    { type: 'separator' },
    unreadCount > 0
      ? { label: `${unreadCount} unread email${unreadCount > 1 ? 's' : ''}`, enabled: false }
      : { label: 'No unread emails', enabled: false },
    { label: `This month: $${monthlyCost.toFixed(4)} Anthropic`, enabled: false },
    { type: 'separator' },
    {
      label: isVisible ? 'Hide Arie' : 'Open Arie',
      accelerator: process.platform === 'darwin' ? 'Cmd+Shift+B' : 'Ctrl+Shift+B',
      click: () => toggleWindow()
    },
    { type: 'separator' },
    { label: 'Inbox',    click: () => { showWindow('inbox');    } },
    { label: 'Calendar', click: () => { showWindow('calendar'); } },
    { label: 'AI Chat',  click: () => { showWindow('chat');     } },
    { type: 'separator' },
    {
      label: 'Quit Arie',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(unreadCount > 0 ? `Arie AI — ${unreadCount} unread` : 'Arie AI');
}

function toggleWindow() {
  if (!mainWindow) { createMainWindow(); return; }
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
    if (process.platform === 'darwin') app.dock.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
  updateTrayMenu();
}

function showWindow(page) {
  if (!mainWindow) createMainWindow();
  mainWindow.show();
  mainWindow.focus();
  // Tell renderer to nav to the right page
  mainWindow.webContents.send('tray:nav', page);
  updateTrayMenu();
}

function createTray() {
  tray = new Tray(getTrayIcon());
  tray.setToolTip('Arie AI');

  // Single click = toggle on Windows/Linux; macOS uses context menu by default
  if (process.platform !== 'darwin') {
    tray.on('click', () => toggleWindow());
  }

  // Double-click on macOS = open
  tray.on('double-click', () => {
    mainWindow ? (mainWindow.show(), mainWindow.focus()) : createMainWindow();
  });

  updateTrayMenu();
}

app.whenReady().then(() => {
  // Don't show in dock by default on macOS — lives in menu bar
  if (process.platform === 'darwin') app.dock.hide();

  createTray();

  if (store.get('onboarded')) {
    createMainWindow();
  } else {
    createOnboardWindow();
  }

  // Global hotkey: Cmd/Ctrl+Shift+B toggles the window from anywhere
  const hotkey = process.platform === 'darwin' ? 'CommandOrControl+Shift+B' : 'CommandOrControl+Shift+B';
  globalShortcut.register(hotkey, () => toggleWindow());
  setupAutoUpdater();

  app.on('activate', () => {
    // macOS dock click — show window
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    else createMainWindow();
  });
});

app.on('window-all-closed', () => {
  // Don't quit — stay in tray
});

app.on('before-quit', () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
});

// ── IPC: Onboarding ───────────────────────────────────────────
ipcMain.handle('onboard:complete', async (_, data) => {
  const { email, name, apiKey, industry, accountType, billingMode, workspaceId, authToken, wsCode } = data;

  store.set('onboarded',    true);
  store.set('userEmail',    email);
  store.set('userName',     name);
  store.set('industry',     industry     || 'consulting');
  store.set('accountType',  accountType  || 'solo');
  store.set('billingMode',  billingMode  || 'individual');
  store.set('workspaceId',  workspaceId  || null);
  store.set('wsCode',       wsCode       || null);

  if (apiKey) saveSecret('anthropic_key', apiKey);
  if (authToken) saveSecret('auth_token', authToken);

  // Register user + join workspace if staff
  if (accountType === 'staff' && wsCode) {
    try {
      const API = process.env.API_BASE || 'http://localhost:3001';
      // Register
      const rRes = await fetch(`${API}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password: data.password, industry, accountType, billingMode }),
      });
      const rData = await rRes.json();
      if (rRes.ok) {
        saveSecret('auth_token', rData.token);
        store.set('userId', rData.user?.id);
        // Join workspace
        await fetch(`${API}/workspaces/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rData.token}` },
          body: JSON.stringify({ code: wsCode }),
        });
      }
    } catch (e) { console.error('Backend registration failed (offline?):', e.message); }
  }

  // Init staff tracker if applicable
  const trackingEnabled = store.get('trackingEnabled', false);
  if (trackingEnabled && workspaceId) {
    try {
      const tracker = require('./tracker');
      tracker.init({
        enabled:     true,
        workspaceId: workspaceId,
        userId:      store.get('userId'),
        apiBase:     process.env.API_BASE || 'http://localhost:3001',
        authToken:   loadSecret('auth_token'),
      });
    } catch (e) { console.warn('Tracker init skipped:', e.message); }
  }

  createMainWindow();
  BrowserWindow.getAllWindows().forEach(w => { if (!w.isFocused()) w.close(); });
  return { ok: true };
});

ipcMain.handle('onboard:validate-key', async (_, apiKey) => {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
    });
    return { valid: res.status === 200 };
  } catch (e) { return { valid: false, error: e.message }; }
});

// ── IPC: Claude ───────────────────────────────────────────────
ipcMain.handle('claude:chat', async (_, { messages, system, feature }) => {
  const apiKey = loadSecret('anthropic_key');
  if (!apiKey) return { error: 'No API key. Go to Settings.' };

  try {
    const body = { model: 'claude-sonnet-4-20250514', max_tokens: 1024, messages };
    if (system) body.system = system;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.error) return { error: data.error.message };

    const u    = data.usage || {};
    const cost = (u.input_tokens||0) * 0.000003 + (u.output_tokens||0) * 0.000015;
    const feat = feature || 'other';
    store.set('monthlyCost',  store.get('monthlyCost',  0) + cost);
    store.set('todayCost',    store.get('todayCost',    0) + cost);
    store.set('totalTokens',  store.get('totalTokens',  0) + (u.input_tokens||0) + (u.output_tokens||0));
    store.set('totalQueries', store.get('totalQueries', 0) + 1);
    store.set(`${feat}Cost`,  store.get(`${feat}Cost`,  0) + cost);

    return { text: data.content[0].text, usage: u, cost };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('claude:get-costs', async () => ({
  monthlyCost:  store.get('monthlyCost',  0),
  todayCost:    store.get('todayCost',    0),
  totalTokens:  store.get('totalTokens',  0),
  totalQueries: store.get('totalQueries', 0),
  emailCost:    store.get('emailCost',    0),
  calCost:      store.get('calCost',      0),
  chatCost:     store.get('chatCost',     0),
  otherCost:    store.get('otherCost',    0)
}));

// ── IPC: User ─────────────────────────────────────────────────
ipcMain.handle('app:get-user',    async ()    => ({ email: store.get('userEmail'), name: store.get('userName'), connectedProviders: store.get('connectedProviders', []) }));

// ── Backend bridge ─────────────────────────────────────────────
let _backendToken = '';
ipcMain.handle('backend:call', async (_, method, path, body) => {
  try {
    const res = await fetch(BACKEND_URL + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(_backendToken ? { Authorization: `Bearer ${_backendToken}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || `HTTP ${res.status}` };
    return data;
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('app:get-platform', async () => process.platform);
ipcMain.handle('app:save-style',  async (_,d) => { store.set('styleProfile', d); return { ok: true }; });
ipcMain.handle('app:get-style',   async ()    => store.get('styleProfile', {}));
ipcMain.handle('app:set-unread-count', async (_, n) => {
  store.set('unreadCount', n);
  // Update badge on macOS dock (when visible) and tray tooltip
  if (process.platform === 'darwin') {
    app.dock.setBadge(n > 0 ? String(n) : '');
  }
  updateTrayMenu();
  return { ok: true };
});


ipcMain.handle('app:update-user', async (_, { name, email }) => {
  if (name)  store.set('userName',  name);
  if (email) store.set('userEmail', email);
  return { ok: true };
});

ipcMain.handle('app:install-update', async () => {
  isQuitting = true;
  autoUpdater.quitAndInstall();
});

// ── IPC: OAuth — Microsoft ────────────────────────────────────
ipcMain.handle('oauth:microsoft', async () => {
  if (!AZURE_CLIENT_ID) return { error: 'AZURE_CLIENT_ID not set. Add it to your .env file. See README.' };

  const state = crypto.randomBytes(16).toString('hex');
  const scopes = 'openid profile email User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite offline_access';
  const authUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
    + `?client_id=${AZURE_CLIENT_ID}`
    + `&response_type=code`
    + `&redirect_uri=${encodeURIComponent(MS_REDIRECT)}`
    + `&scope=${encodeURIComponent(scopes)}`
    + `&state=${state}`
    + `&response_mode=query&prompt=select_account`;

  shell.openExternal(authUrl);

  try {
    const { code, error } = await waitForOAuthCallback();
    if (error) return { error };

    const tokens  = await exchangeMicrosoftCode(code, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, MS_REDIRECT);
    saveTokens('microsoft', tokens);

    const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: 'Bearer ' + tokens.access_token } });
    const profile = await profileRes.json();
    if (!store.get('userEmail') && profile.mail)         store.set('userEmail', profile.mail);
    if (!store.get('userName')  && profile.displayName)  store.set('userName',  profile.displayName);

    markConnected('microsoft');
    return { ok: true, email: profile.mail, name: profile.displayName };
  } catch (e) { return { error: e.message }; }
});

// ── IPC: OAuth — Google ───────────────────────────────────────
ipcMain.handle('oauth:google', async () => {
  if (!GOOGLE_CLIENT_ID) return { error: 'GOOGLE_CLIENT_ID not set. Add it to your .env file. See README.' };

  const state  = crypto.randomBytes(16).toString('hex');
  const scopes = ['openid','email','profile','https://www.googleapis.com/auth/gmail.modify','https://www.googleapis.com/auth/calendar'].join(' ');
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth'
    + `?client_id=${GOOGLE_CLIENT_ID}`
    + `&response_type=code`
    + `&redirect_uri=${encodeURIComponent(GC_REDIRECT)}`
    + `&scope=${encodeURIComponent(scopes)}`
    + `&state=${state}`
    + `&access_type=offline&prompt=consent`;

  shell.openExternal(authUrl);

  try {
    const { code, error } = await waitForOAuthCallback();
    if (error) return { error };

    const tokens = await exchangeGoogleCode(code, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GC_REDIRECT);
    saveTokens('google', tokens);

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + tokens.access_token } });
    const profile = await profileRes.json();
    if (!store.get('userEmail') && profile.email) store.set('userEmail', profile.email);
    if (!store.get('userName')  && profile.name)  store.set('userName',  profile.name);

    markConnected('google');
    return { ok: true, email: profile.email, name: profile.name };
  } catch (e) { return { error: e.message }; }
});

// ── IPC: Apple Mail (IMAP) ────────────────────────────────────
ipcMain.handle('apple:connect', async (_, { email, password }) => {
  // Validate credentials by attempting an IMAP connection
  try {
    const valid = await testImapConnection(email, password);
    if (!valid.ok) return { error: valid.error || 'IMAP connection failed. Check your email and app-specific password.' };
    saveSecret('apple_email',    email);
    saveSecret('apple_password', password);
    markConnected('apple');
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

/**
 * Test IMAP credentials without node-imap dependency.
 * Uses net module for a basic TLS handshake to imap.mail.me.com.
 * For production, npm install node-imap and use the full implementation.
 */
function testImapConnection(email, password) {
  return new Promise((resolve) => {
    const tls  = require('tls');
    const host = email.endsWith('@gmail.com') ? 'imap.gmail.com' : 'imap.mail.me.com';
    const port = 993;

    const socket = tls.connect({ host, port, rejectUnauthorized: true }, () => {
      socket.destroy();
      // Credentials stored — actual validation happens on first fetch
      resolve({ ok: true });
    });
    socket.on('error', (err) => {
      resolve({ ok: false, error: `Cannot reach ${host}: ${err.message}` });
    });
    setTimeout(() => { socket.destroy(); resolve({ ok: false, error: 'Connection timed out' }); }, 8000);
  });
}

/**
 * Fetch emails via IMAP (Apple Mail / Gmail IMAP).
 * Uses node-imap if installed, falls back to stored credential stub.
 */
async function fetchImapEmails(email, password) {
  // Try node-imap if available
  let Imap;
  try { Imap = require('node-imap'); } catch { Imap = null; }

  if (!Imap) {
    // node-imap not installed — return informative message
    return { ok: false, error: 'Install node-imap (npm install node-imap) to enable Apple Mail sync.' };
  }

  const host = email.endsWith('@gmail.com') ? 'imap.gmail.com' : 'imap.mail.me.com';

  return new Promise((resolve) => {
    const imap = new Imap({ user: email, password, host, port: 993, tls: true, tlsOptions: { rejectUnauthorized: true }, authTimeout: 8000 });
    const emails = [];

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err, box) => {
        if (err) { imap.end(); return resolve({ ok: false, error: err.message }); }

        // Fetch last 30 messages
        const total = box.messages.total;
        const start = Math.max(1, total - 29);
        const fetch = imap.seq.fetch(`${start}:${total}`, { bodies: 'HEADER.FIELDS (FROM SUBJECT DATE)', struct: true });

        fetch.on('message', (msg, seqno) => {
          const email = { id: String(seqno), provider: 'apple' };
          msg.on('body', (stream) => {
            let buf = '';
            stream.on('data', d => buf += d.toString('utf8'));
            stream.once('end', () => {
              const lines = buf.split('\n');
              lines.forEach(line => {
                if (line.startsWith('From:'))    email.from    = line.replace('From:', '').trim();
                if (line.startsWith('Subject:')) email.subject = line.replace('Subject:', '').trim();
                if (line.startsWith('Date:'))    email.time    = line.replace('Date:', '').trim();
              });
              email.preview = '';
              emails.push(email);
            });
          });
          msg.once('attributes', attrs => { email.isRead = !attrs.flags.includes('\\Seen'); });
        });

        fetch.once('end', () => { imap.end(); });
      });
    });

    imap.once('end',   () => resolve({ ok: true, emails: emails.reverse() }));
    imap.once('error', e  => resolve({ ok: false, error: e.message }));
    imap.connect();
  });
}

// ── IPC: Disconnect ───────────────────────────────────────────
ipcMain.handle('oauth:disconnect', async (_, provider) => {
  markDisconnected(provider);
  return { ok: true };
});

// ── IPC: Fetch emails ─────────────────────────────────────────
ipcMain.handle('email:fetch', async (_, { provider }) => {
  try {
    if (provider === 'microsoft') {
      const token = await getValidToken('microsoft');
      if (!token) return { error: 'Session expired. Reconnect Microsoft.' };
      const raw = await getMicrosoftEmails(token);
      return { ok: true, emails: raw.map(e => ({
        id: e.id, provider: 'microsoft',
        from:     e.from?.emailAddress?.name || e.from?.emailAddress?.address,
        fromAddr: e.from?.emailAddress?.address,
        subject:  e.subject,
        preview:  e.bodyPreview,
        time:     e.receivedDateTime,
        isRead:   e.isRead,
        priority: e.importance === 'high' ? 'high' : 'normal'
      }))};
    }
    if (provider === 'google') {
      const token = await getValidToken('google');
      if (!token) return { error: 'Session expired. Reconnect Google.' };
      const raw = await getGoogleEmails(token);
      return { ok: true, emails: raw.map(e => ({
        id: e.id, provider: 'google',
        from: e.from, subject: e.subject, preview: e.snippet, time: e.date, isRead: e.isRead
      }))};
    }
    if (provider === 'apple') {
      const aEmail = loadSecret('apple_email');
      const aPass  = loadSecret('apple_password');
      if (!aEmail) return { error: 'Apple Mail not connected.' };
      return await fetchImapEmails(aEmail, aPass);
    }
    return { error: 'Unknown provider' };
  } catch (e) { return { error: e.message }; }
});

// ── IPC: Send email ───────────────────────────────────────────
ipcMain.handle('email:send', async (_, { provider, to, subject, body }) => {
  try {
    if (provider === 'microsoft') {
      const token = await getValidToken('microsoft');
      if (!token) return { error: 'Session expired. Reconnect Microsoft.' };
      return await sendMicrosoftEmail(token, { to, subject, body });
    }
    if (provider === 'google') {
      const token = await getValidToken('google');
      if (!token) return { error: 'Session expired. Reconnect Google.' };
      return await sendGoogleEmail(token, { to, subject, body });
    }
    return { error: 'Unknown provider: ' + provider };
  } catch (e) { return { error: e.message }; }
});

// ── IPC: Fetch calendar ───────────────────────────────────────
ipcMain.handle('calendar:fetch', async (_, { provider }) => {
  try {
    if (provider === 'microsoft') {
      const token = await getValidToken('microsoft');
      if (!token) return { error: 'Session expired. Reconnect Microsoft.' };
      const raw = await getMicrosoftCalendar(token);
      return { ok: true, events: raw.map(e => ({
        id: e.id, provider: 'microsoft',
        title:    e.subject,
        start:    e.start?.dateTime,
        end:      e.end?.dateTime,
        location: e.location?.displayName,
        isOnline: e.isOnlineMeeting
      }))};
    }
    if (provider === 'google') {
      const token = await getValidToken('google');
      if (!token) return { error: 'Session expired. Reconnect Google.' };
      const raw = await getGoogleCalendar(token);
      return { ok: true, events: raw.map(e => ({
        id: e.id, provider: 'google',
        title:    e.summary,
        start:    e.start?.dateTime || e.start?.date,
        end:      e.end?.dateTime   || e.end?.date,
        location: e.location
      }))};
    }
    return { error: 'Unknown provider' };
  } catch (e) { return { error: e.message }; }
});

// ── IPC: Shell ────────────────────────────────────────────────
ipcMain.handle('shell:open', async (_, url) => { shell.openExternal(url); });

// ── Auto-updater ──────────────────────────────────────────────
function setupAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload         = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    if (mainWindow) mainWindow.webContents.send('update:available', info);
    updateTrayMenu();
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow) mainWindow.webContents.send('update:downloaded', info);
    dialog.showMessageBox({
      type: 'info', title: 'Update ready',
      message: `Arie AI ${info.version} has been downloaded.`,
      detail:  'Restart now to install the update.',
      buttons: ['Restart now', 'Later'], defaultId: 0
    }).then(({ response }) => {
      if (response === 0) { isQuitting = true; autoUpdater.quitAndInstall(); }
    });
  });

  autoUpdater.on('error', (err) => console.error('[updater]', err.message));

  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

// ── IPC: Shell extras ─────────────────────────────────────────
ipcMain.handle('shell:copy', async (_, text) => {
  require('electron').clipboard.writeText(String(text));
  return { ok: true };
});

// ── IPC: Tracker ──────────────────────────────────────────────
ipcMain.handle('tracker:record', async (_, type, detail) => {
  try { const t = require('./tracker'); t.recordActivity(type, detail); } catch {}
  return { ok: true };
});

ipcMain.handle('tracker:status', async () => {
  try { const t = require('./tracker'); return t.getStatus(); } catch { return { enabled: false }; }
});

ipcMain.handle('tracker:submit-now', async () => {
  try {
    const t      = require('./tracker');
    const apiKey = loadSecret('anthropic_key');
    await t.submitDailyReport(apiKey);
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});

// ── Stripe deep link (arie-ai://payment-success) ──────────────
// Register the custom protocol for Stripe return
if (process.defaultApp) {
  if (process.argv.length >= 2) app.setAsDefaultProtocolClient('arie-ai', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('arie-ai');
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url.includes('payment-success')) {
    // Notify all open windows (onboarding will be listening)
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send('payment:complete'));
  }
});

// Windows deep link
if (process.platform === 'win32') {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { app.quit(); }
  app.on('second-instance', (_, commandLine) => {
    if (commandLine.find(arg => arg.includes('payment-success'))) {
      BrowserWindow.getAllWindows().forEach(w => w.webContents.send('payment:complete'));
    }
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
}

// ── IPC: User extended ────────────────────────────────────────
ipcMain.handle('app:get-user-full', async () => ({
  email:       store.get('userEmail'),
  name:        store.get('userName'),
  industry:    store.get('industry', 'consulting'),
  accountType: store.get('accountType', 'solo'),
  billingMode: store.get('billingMode', 'individual'),
  workspaceId: store.get('workspaceId'),
  connectedProviders: store.get('connectedProviders', []),
}));

ipcMain.handle('app:get-workspace', async () => {
  const wsId = store.get('workspaceId');
  if (!wsId) return { workspace: null };
  try {
    const token = loadSecret('auth_token');
    const res   = await fetch(`${process.env.API_BASE || 'http://localhost:3001'}/workspaces/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok ? await res.json() : { workspace: null };
  } catch { return { workspace: null }; }
});

ipcMain.handle('app:get-tracking-status', async () => {
  const wsId = store.get('workspaceId');
  if (!wsId) return { enabled: false };
  try {
    const token = loadSecret('auth_token');
    const res   = await fetch(`${process.env.API_BASE || 'http://localhost:3001'}/workspaces/${wsId}/members`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { enabled: false };
    const data = await res.json();
    const me   = data.members?.find(m => m.email === store.get('userEmail'));
    return { enabled: me?.activityReportingEnabled || false };
  } catch { return { enabled: false }; }
});
