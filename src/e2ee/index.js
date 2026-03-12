/**
 * Arie AI — Client-Side E2EE Module (Electron Main Process)
 *
 * This module runs exclusively in the Electron main process.
 * It handles:
 *   1. Generating keypairs on first launch
 *   2. Storing private keys in the OS keychain via safeStorage
 *   3. Deriving the local DB encryption key from the user's password
 *   4. Encrypting data before any API call
 *   5. Decrypting data received from the API
 *   6. Compiling and encrypting daily staff reports
 *
 * Private keys NEVER leave this module in plaintext.
 * They are stored encrypted via Electron's safeStorage (OS keychain backed).
 */

const { safeStorage, app } = require('electron');
const path   = require('path');
const fs     = require('fs');
const sodium = require('libsodium-wrappers');

// ── Key file paths ─────────────────────────────────────────────────
// Encrypted key blobs stored in the app's user data directory.
// safeStorage encrypts these with OS-level protection (Keychain / DPAPI / libsecret).
const KEY_DIR         = path.join(app.getPath('userData'), 'keys');
const ENC_KEY_FILE    = path.join(KEY_DIR, 'enc.key');   // X25519 private key (encrypted blob)
const SIGN_KEY_FILE   = path.join(KEY_DIR, 'sign.key');  // Ed25519 private key (encrypted blob)
const DB_SALT_FILE    = path.join(KEY_DIR, 'db.salt');   // Argon2 salt for DB key derivation
const PUB_KEY_FILE    = path.join(KEY_DIR, 'pub.json');  // Public keys (not sensitive, cached)

let _ready = false;
let _encPrivateKey  = null;  // Uint8Array — loaded into memory only when needed
let _signPrivateKey = null;
let _encPublicKey   = null;
let _signPublicKey  = null;

// ── Init ───────────────────────────────────────────────────────────

async function init() {
  if (_ready) return;
  await sodium.ready;
  if (!fs.existsSync(KEY_DIR)) fs.mkdirSync(KEY_DIR, { recursive: true });
  _ready = true;
}

function ensureReady() {
  if (!_ready) throw new Error('E2EE module not initialised. Call e2ee.init() first.');
}

// ── Keypair generation & storage ───────────────────────────────────

/**
 * Generates keypairs and saves them to the OS keychain via safeStorage.
 * Call once during onboarding after the user sets their password.
 * Returns the public keys so they can be registered with the backend.
 *
 * @returns {{ encryptionPublicKey: string, signingPublicKey: string }}
 */
async function generateAndStoreKeypairs() {
  ensureReady();

  const encKeypair  = sodium.crypto_box_keypair();
  const signKeypair = sodium.crypto_sign_keypair();

  // Encrypt private keys with OS keychain before writing to disk
  const encPrivBlob  = safeStorage.encryptString(toBase64(encKeypair.privateKey));
  const signPrivBlob = safeStorage.encryptString(toBase64(signKeypair.privateKey));

  fs.writeFileSync(ENC_KEY_FILE,  encPrivBlob);
  fs.writeFileSync(SIGN_KEY_FILE, signPrivBlob);

  const pubKeys = {
    encryptionPublicKey: toBase64(encKeypair.publicKey),
    signingPublicKey:    toBase64(signKeypair.publicKey),
  };
  fs.writeFileSync(PUB_KEY_FILE, JSON.stringify(pubKeys));

  // Cache in memory for this session
  _encPrivateKey  = encKeypair.privateKey;
  _signPrivateKey = signKeypair.privateKey;
  _encPublicKey   = encKeypair.publicKey;
  _signPublicKey  = signKeypair.publicKey;

  return pubKeys;
}

/**
 * Loads keypairs from disk into memory for this session.
 * Call on app launch after user authenticates.
 */
async function loadKeypairs() {
  ensureReady();
  if (!fs.existsSync(ENC_KEY_FILE) || !fs.existsSync(SIGN_KEY_FILE)) {
    return false; // Keys not yet generated — trigger onboarding
  }

  const encPrivBlob  = fs.readFileSync(ENC_KEY_FILE);
  const signPrivBlob = fs.readFileSync(SIGN_KEY_FILE);

  _encPrivateKey  = fromBase64(safeStorage.decryptString(encPrivBlob));
  _signPrivateKey = fromBase64(safeStorage.decryptString(signPrivBlob));

  const pub = JSON.parse(fs.readFileSync(PUB_KEY_FILE, 'utf8'));
  _encPublicKey  = fromBase64(pub.encryptionPublicKey);
  _signPublicKey = fromBase64(pub.signingPublicKey);

  return true;
}

/**
 * Returns the user's public keys (safe to share with backend).
 */
function getPublicKeys() {
  ensureReady();
  if (!_encPublicKey || !_signPublicKey) throw new Error('Keys not loaded.');
  const pub = JSON.parse(fs.readFileSync(PUB_KEY_FILE, 'utf8'));
  return pub;
}

/**
 * Returns true if keypairs have been generated for this user.
 */
function hasKeypairs() {
  return fs.existsSync(ENC_KEY_FILE) && fs.existsSync(SIGN_KEY_FILE);
}

// ── Local DB key derivation ────────────────────────────────────────

/**
 * Derives the local SQLite DB encryption key from the user's password.
 * The salt is generated once and stored (unencrypted — salts are not secret).
 * The derived key is NOT stored — it is re-derived on each launch.
 *
 * @param {string} password — user's plaintext password (from login form, immediately cleared)
 * @returns {string}        — base64-encoded 32-byte key for SQLCipher
 */
async function deriveDbKey(password) {
  ensureReady();

  let salt;
  if (fs.existsSync(DB_SALT_FILE)) {
    salt = fs.readFileSync(DB_SALT_FILE); // Buffer
  } else {
    salt = Buffer.from(sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES));
    fs.writeFileSync(DB_SALT_FILE, salt);
  }

  const key = sodium.crypto_pwhash(
    32,
    password,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );

  return toBase64(key);
}

// ── Symmetric field encryption (for local DB / local cache) ────────

/**
 * Encrypts a value symmetrically using the DB key.
 * Use for sensitive fields written to the local SQLite database.
 *
 * @param {string|object} value
 * @param {string} dbKeyBase64
 * @returns {string} "nonce:ciphertext"
 */
function encryptForStorage(value, dbKeyBase64) {
  ensureReady();
  const key = fromBase64(dbKeyBase64);
  const plaintext = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, key);
  return `${toBase64(nonce)}:${toBase64(ciphertext)}`;
}

/**
 * Decrypts a value from the local DB.
 */
function decryptFromStorage(encrypted, dbKeyBase64) {
  ensureReady();
  const key = fromBase64(dbKeyBase64);
  const [nonceB64, ciphertextB64] = encrypted.split(':');
  const plaintext = sodium.crypto_secretbox_open_easy(
    fromBase64(ciphertextB64),
    fromBase64(nonceB64),
    key
  );
  return Buffer.from(plaintext).toString('utf8');
}

// ── Asymmetric encryption (for sending to admin) ───────────────────

/**
 * Encrypts data for the workspace admin using their public key.
 * Only the admin, holding the matching private key, can decrypt.
 *
 * @param {string|object} data
 * @param {string} adminPublicKeyBase64 — fetched from backend /api/keys/admin/:wsId
 * @returns {{ encrypted: string, senderPublicKey: string }}
 */
function encryptForAdmin(data, adminPublicKeyBase64) {
  ensureReady();
  if (!_encPrivateKey) throw new Error('Private key not loaded.');

  const plaintext = typeof data === 'object' ? JSON.stringify(data) : String(data);
  const nonce     = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);

  const ciphertext = sodium.crypto_box_easy(
    plaintext,
    nonce,
    fromBase64(adminPublicKeyBase64),
    _encPrivateKey
  );

  return {
    payload:         `${toBase64(nonce)}:${toBase64(ciphertext)}`,
    senderPublicKey: toBase64(_encPublicKey),
  };
}

/**
 * Decrypts data sent to this user (i.e. admin decrypting a staff report).
 *
 * @param {string} encrypted       — "nonce:ciphertext"
 * @param {string} senderPublicKey — base64 X25519
 * @returns {string} plaintext
 */
function decryptFromSender(encrypted, senderPublicKeyBase64) {
  ensureReady();
  if (!_encPrivateKey) throw new Error('Private key not loaded.');

  const [nonceB64, ciphertextB64] = encrypted.split(':');
  const plaintext = sodium.crypto_box_open_easy(
    fromBase64(ciphertextB64),
    fromBase64(nonceB64),
    fromBase64(senderPublicKeyBase64),
    _encPrivateKey
  );
  return Buffer.from(plaintext).toString('utf8');
}

// ── Signing ────────────────────────────────────────────────────────

/**
 * Signs a daily report payload so the admin can verify it hasn't been tampered with.
 * @param {string|object} payload
 * @returns {string} base64 detached signature
 */
function signReport(payload) {
  ensureReady();
  if (!_signPrivateKey) throw new Error('Signing key not loaded.');
  const msg = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
  const sig = sodium.crypto_sign_detached(msg, _signPrivateKey);
  return toBase64(sig);
}

/**
 * Verifies a report signature.
 * Admin calls this after decrypting a report.
 *
 * @param {string|object} payload
 * @param {string} signatureBase64
 * @param {string} senderSigningPublicKeyBase64
 * @returns {boolean}
 */
function verifyReport(payload, signatureBase64, senderSigningPublicKeyBase64) {
  ensureReady();
  const msg = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
  return sodium.crypto_sign_verify_detached(
    fromBase64(signatureBase64),
    msg,
    fromBase64(senderSigningPublicKeyBase64)
  );
}

// ── Daily report compilation ───────────────────────────────────────

/**
 * Compiles and encrypts a daily staff report ready to POST to /api/reports.
 *
 * Workflow:
 *   1. Build the report object from today's activity data
 *   2. Sign the plaintext payload with the staff member's signing key
 *   3. Encrypt the payload with the admin's public key
 *   4. Return the encrypted bundle ready to POST
 *
 * @param {object} activityData       — { tasksCompleted, activeHours, peakHours, summaryText }
 * @param {string} adminPublicKeyB64  — fetched from /api/keys/admin/:wsId
 * @param {string} workspaceId
 * @returns {object}                  — ready to POST to /api/reports
 */
async function compileDailyReport(activityData, adminPublicKeyB64, workspaceId) {
  ensureReady();

  const today = new Date().toISOString().slice(0, 10);

  const report = {
    date:            today,
    workspace_id:    workspaceId,
    tasks_completed: activityData.tasksCompleted ?? [],
    active_hours:    activityData.activeHours ?? 0,
    peak_hours:      activityData.peakHours ?? null,
    summary:         activityData.summaryText ?? '',
    generated_at:    new Date().toISOString(),
  };

  // Sign the plaintext before encrypting
  const signature = signReport(report);

  // Encrypt for admin
  const { payload, senderPublicKey } = encryptForAdmin(report, adminPublicKeyB64);

  return {
    payload,
    signature,
    sender_public_key: senderPublicKey,
    workspace_id:      workspaceId,
    report_date:       today,
  };
}

// ── Key clearing ───────────────────────────────────────────────────

/**
 * Clears private keys from memory on logout.
 * They remain safely stored on disk — this just removes the in-memory copy.
 */
function clearMemory() {
  if (_encPrivateKey)  _encPrivateKey.fill(0);
  if (_signPrivateKey) _signPrivateKey.fill(0);
  _encPrivateKey  = null;
  _signPrivateKey = null;
  _encPublicKey   = null;
  _signPublicKey  = null;
}

// ── Helpers ────────────────────────────────────────────────────────

function toBase64(buf)  { return Buffer.from(buf).toString('base64'); }
function fromBase64(s)  { return Buffer.from(s, 'base64'); }

// ── Exports ────────────────────────────────────────────────────────

module.exports = {
  init,
  generateAndStoreKeypairs,
  loadKeypairs,
  getPublicKeys,
  hasKeypairs,
  deriveDbKey,
  encryptForStorage,
  decryptFromStorage,
  encryptForAdmin,
  decryptFromSender,
  signReport,
  verifyReport,
  compileDailyReport,
  clearMemory,
};
