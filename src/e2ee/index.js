/**
 * E2EE wrapper for the Electron main process.
 * Delegates to the shared client-e2ee module.
 *
 * FIX: Correct path — app/src/e2ee/index.js → backend/client-e2ee/index.js
 */
'use strict';

const path = require('path');

let e2eeModule;

try {
  e2eeModule = require(path.join(__dirname, '../../../backend/client-e2ee/index.js'));
} catch {
  // Fallback if running from inside app/
  e2eeModule = require(path.join(__dirname, '../../../../backend/client-e2ee/index.js'));
}

module.exports = e2eeModule;
