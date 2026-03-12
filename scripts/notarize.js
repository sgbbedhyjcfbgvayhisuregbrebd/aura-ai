/**
 * scripts/notarize.js
 * Called by electron-builder afterSign hook.
 * Only runs on macOS when APPLE_ID is set in environment.
 * 
 * Setup:
 *   export APPLE_ID=your@apple.com
 *   export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx  (from appleid.apple.com)
 *   export APPLE_TEAM_ID=XXXXXXXXXX  (from developer.apple.com)
 */

const { notarize } = require('@electron/notarize');
const path = require('path');

module.exports = async function (context) {
  const { electronPlatformName, appOutDir } = context;

  // Only notarize on macOS
  if (electronPlatformName !== 'darwin') return;

  // Skip if no Apple credentials — unsigned build
  if (!process.env.APPLE_ID) {
    console.log('[notarize] APPLE_ID not set — skipping notarization');
    return;
  }

  const appName   = context.packager.appInfo.productFilename;
  const appPath   = path.join(appOutDir, `${appName}.app`);
  const appleId   = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId    = process.env.APPLE_TEAM_ID;

  console.log(`[notarize] Notarizing ${appPath}...`);
  console.log(`[notarize] Apple ID: ${appleId}`);

  await notarize({
    tool:     'notarytool',
    appPath,
    appleId,
    appleIdPassword,
    teamId
  });

  console.log('[notarize] Done.');
};
