/**
 * Arie AI — Offline Sync Service (Electron Main Process)
 *
 * Enables core features to work without internet.
 * 
 * Strategy:
 *   READS  — responses cached locally in SQLite (better-sqlite3)
 *            stale-while-revalidate: serve cache immediately, refresh in background
 *
 *   WRITES — queued in a local outbox when offline
 *            replayed in order when connection is restored
 *
 *   AI     — disabled when offline (requires Anthropic API)
 *            previously generated drafts remain accessible from cache
 */

const { ipcMain, net } = require('electron');
const Database = require('better-sqlite3');
const path     = require('path');
const { app }  = require('electron');

// ── Local cache DB (separate from main app DB) ─────────────────────
const CACHE_PATH = path.join(app.getPath('userData'), 'offline-cache.db');
let   cacheDb    = null;

function initCacheDb() {
  cacheDb = new Database(CACHE_PATH);

  cacheDb.exec(`
    CREATE TABLE IF NOT EXISTS response_cache (
      key        TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      cached_at  INTEGER NOT NULL,
      ttl_ms     INTEGER NOT NULL DEFAULT 300000
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      method     TEXT NOT NULL,
      url        TEXT NOT NULL,
      body       TEXT,
      headers    TEXT,
      created_at INTEGER NOT NULL,
      attempts   INTEGER DEFAULT 0,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS offline_drafts (
      id         TEXT PRIMARY KEY,
      type       TEXT NOT NULL,
      content    TEXT NOT NULL,
      context    TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  return cacheDb;
}

// ── Online detection ───────────────────────────────────────────────

let _isOnline = true;
let _onlineCallbacks  = [];
let _offlineCallbacks = [];

function checkOnline() {
  return net.isOnline();
}

function onOnline(cb)  { _onlineCallbacks.push(cb); }
function onOffline(cb) { _offlineCallbacks.push(cb); }

// FIX: do NOT start setInterval at module load time. The interval is started inside
// init() so that cacheDb is guaranteed to be initialised before replayOutbox() runs.
let _pollTimer = null;

function startNetworkPoller() {
  if (_pollTimer) return;
  _pollTimer = setInterval(() => {
    const nowOnline = checkOnline();
    if (nowOnline !== _isOnline) {
      _isOnline = nowOnline;
      if (_isOnline) {
        console.log('[sync] Connection restored — replaying outbox');
        _onlineCallbacks.forEach(cb => cb());
        replayOutbox();
      } else {
        console.log('[sync] Connection lost — offline mode active');
        _offlineCallbacks.forEach(cb => cb());
      }
    }
  }, 15000);
}

// ── Cache: read ────────────────────────────────────────────────────

/**
 * Get a cached response by key.
 * Returns null if not found or expired.
 *
 * @param {string} key
 * @returns {any|null}
 */
function getCached(key) {
  if (!cacheDb) return null;
  const row = cacheDb.prepare(
    `SELECT data, cached_at, ttl_ms FROM response_cache WHERE key = ?`
  ).get(key);

  if (!row) return null;
  if (Date.now() - row.cached_at > row.ttl_ms) {
    cacheDb.prepare(`DELETE FROM response_cache WHERE key = ?`).run(key);
    return null;
  }

  try { return JSON.parse(row.data); } catch { return null; }
}

/**
 * Store a response in the cache.
 *
 * @param {string} key
 * @param {any}    data
 * @param {number} ttlMs  — time-to-live in milliseconds (default 5 min)
 */
function setCached(key, data, ttlMs = 300000) {
  if (!cacheDb) return;
  cacheDb.prepare(
    `INSERT OR REPLACE INTO response_cache (key, data, cached_at, ttl_ms)
     VALUES (?, ?, ?, ?)`
  ).run(key, JSON.stringify(data), Date.now(), ttlMs);
}

/**
 * Invalidate a cache key or prefix.
 * Pass a key ending in '*' to delete all matching keys.
 */
function invalidateCache(keyOrPrefix) {
  if (!cacheDb) return;
  if (keyOrPrefix.endsWith('*')) {
    const prefix = keyOrPrefix.slice(0, -1);
    cacheDb.prepare(`DELETE FROM response_cache WHERE key LIKE ?`).run(`${prefix}%`);
  } else {
    cacheDb.prepare(`DELETE FROM response_cache WHERE key = ?`).run(keyOrPrefix);
  }
}

// ── Outbox: write queue ────────────────────────────────────────────

/**
 * Queue a write operation for later replay.
 * Called automatically when a fetch fails due to being offline.
 *
 * @param {string} method
 * @param {string} url
 * @param {object} body
 * @param {object} headers
 */
function enqueue(method, url, body, headers = {}) {
  if (!cacheDb) return;
  cacheDb.prepare(
    `INSERT INTO outbox (method, url, body, headers, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(method, url, body ? JSON.stringify(body) : null, JSON.stringify(headers), Date.now());
  console.log(`[sync] Queued ${method} ${url} for later replay`);
}

/**
 * Replay all queued outbox items in order.
 * Called when the connection is restored.
 */
async function replayOutbox() {
  if (!cacheDb) return;
  const items = cacheDb.prepare(
    `SELECT * FROM outbox ORDER BY id ASC LIMIT 50`
  ).all();

  if (items.length === 0) return;
  console.log(`[sync] Replaying ${items.length} queued requests`);

  for (const item of items) {
    try {
      const headers = JSON.parse(item.headers || '{}');
      const body    = item.body ? JSON.parse(item.body) : undefined;

      const res = await fetch(item.url, {
        method:  item.method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body:    body ? JSON.stringify(body) : undefined,
      });

      if (res.ok) {
        cacheDb.prepare(`DELETE FROM outbox WHERE id = ?`).run(item.id);
        console.log(`[sync] Replayed: ${item.method} ${item.url}`);
      } else {
        cacheDb.prepare(
          `UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?`
        ).run(`HTTP ${res.status}`, item.id);
      }
    } catch (err) {
      cacheDb.prepare(
        `UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?`
      ).run(err.message, item.id);
    }
  }

  // Drop items that have failed too many times
  cacheDb.prepare(`DELETE FROM outbox WHERE attempts >= 5`).run();
}

// ── Offline-aware fetch wrapper ────────────────────────────────────

/**
 * Drop-in replacement for fetch that:
 * - Serves cache when offline
 * - Queues mutations when offline
 * - Updates cache on successful reads
 *
 * @param {string} url
 * @param {object} options   — standard fetch options + { cacheKey?, ttlMs?, skipCache? }
 * @returns {object}         — { data, fromCache: boolean, queued: boolean }
 */
async function syncFetch(url, options = {}) {
  const { cacheKey, ttlMs, skipCache, ...fetchOptions } = options;
  const isRead = !fetchOptions.method || fetchOptions.method === 'GET';
  const key    = cacheKey || url;

  // Offline handling
  if (!checkOnline()) {
    if (isRead) {
      const cached = getCached(key);
      if (cached) return { data: cached, fromCache: true, queued: false };
      throw new Error('Offline and no cached data available for this request');
    } else {
      // Queue write for later
      const body = fetchOptions.body ? JSON.parse(fetchOptions.body) : undefined;
      enqueue(fetchOptions.method, url, body, fetchOptions.headers || {});
      return { data: null, fromCache: false, queued: true };
    }
  }

  // Online — serve cache while fetching fresh (stale-while-revalidate for reads)
  if (isRead && !skipCache) {
    const cached = getCached(key);
    if (cached) {
      // Return cached immediately, refresh in background
      fetch(url, fetchOptions)
        .then(r => r.json())
        .then(fresh => setCached(key, fresh, ttlMs))
        .catch(() => {});
      return { data: cached, fromCache: true, queued: false };
    }
  }

  // Fresh fetch
  const res  = await fetch(url, fetchOptions);
  const data = await res.json();

  if (res.ok && isRead) {
    setCached(key, data, ttlMs);
  }

  return { data, fromCache: false, queued: false };
}

// ── Offline draft storage ──────────────────────────────────────────

/**
 * Save a draft locally for offline access.
 * AI-generated drafts are stored here so they're available without internet.
 */
function saveDraftOffline(id, type, content, context = '') {
  if (!cacheDb) return;
  cacheDb.prepare(
    `INSERT OR REPLACE INTO offline_drafts (id, type, content, context, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, type, content, context, Date.now());
}

function getOfflineDraft(id) {
  if (!cacheDb) return null;
  return cacheDb.prepare(`SELECT * FROM offline_drafts WHERE id = ?`).get(id);
}

function listOfflineDrafts(type = null) {
  if (!cacheDb) return [];
  if (type) {
    return cacheDb.prepare(`SELECT * FROM offline_drafts WHERE type = ? ORDER BY created_at DESC`).all(type);
  }
  return cacheDb.prepare(`SELECT * FROM offline_drafts ORDER BY created_at DESC LIMIT 100`).all();
}

// ── IPC handlers ───────────────────────────────────────────────────

ipcMain.handle('sync:isOnline',         () => checkOnline());
ipcMain.handle('sync:getOutboxCount',   () => cacheDb?.prepare('SELECT COUNT(*) as n FROM outbox').get()?.n ?? 0);
ipcMain.handle('sync:replayOutbox',     () => replayOutbox());
ipcMain.handle('sync:listDrafts',       (_, type) => listOfflineDrafts(type));
ipcMain.handle('sync:getDraft',         (_, id)   => getOfflineDraft(id));
ipcMain.handle('sync:saveDraft',        (_, id, type, content, context) => saveDraftOffline(id, type, content, context));
ipcMain.handle('sync:invalidateCache',  (_, key)  => invalidateCache(key));

// ── Init & exports ─────────────────────────────────────────────────

function init() {
  initCacheDb();
  // FIX: network poller is now started here, AFTER cacheDb is ready
  startNetworkPoller();
  console.log('[sync] Offline sync service ready');
}

function stop() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

function getOutboxCount() {
  return cacheDb?.prepare('SELECT COUNT(*) as n FROM outbox').get()?.n ?? 0;
}

module.exports = {
  init,
  stop,
  checkOnline,
  onOnline,
  onOffline,
  getCached,
  setCached,
  invalidateCache,
  enqueue,
  replayOutbox,
  syncFetch,
  saveDraftOffline,
  getOfflineDraft,
  listOfflineDrafts,
  getOutboxCount,
};
