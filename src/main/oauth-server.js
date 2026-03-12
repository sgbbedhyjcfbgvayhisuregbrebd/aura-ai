const http = require('http');
const { URL } = require('url');

let server = null;
let resolveCallback = null;

/**
 * Starts a one-shot local HTTP server on port 3000.
 * Returns a promise that resolves with { code, state } when the OAuth
 * provider redirects back, or rejects after a timeout.
 */
function waitForOAuthCallback(timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    if (server) {
      server.close();
      server = null;
    }

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('OAuth timeout — user did not complete sign-in within 2 minutes'));
    }, timeoutMs);

    resolveCallback = (result) => {
      clearTimeout(timeout);
      cleanup();
      resolve(result);
    };

    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost:3000');

      // Microsoft and Google both use /auth/*/callback
      if (url.pathname.startsWith('/auth/')) {
        const code  = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');
        const errorDesc = url.searchParams.get('error_description');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(htmlPage('Sign-in failed', `<p style="color:#FB7185">${errorDesc || error}</p><p>You can close this tab.</p>`, false));
          resolveCallback({ error: errorDesc || error });
          return;
        }

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(htmlPage('Signed in', '<p>You\'re connected. You can close this tab and return to Arie AI.</p>', true));
          resolveCallback({ code, state });
          return;
        }
      }

      // Fallback
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(htmlPage('Arie AI', '<p>Waiting for sign-in...</p>', false));
    });

    server.listen(3000, '127.0.0.1', () => {
      console.log('[oauth] Callback server listening on http://localhost:3000');
    });

    server.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error('Could not start OAuth callback server: ' + err.message));
    });
  });
}

function cleanup() {
  if (server) {
    server.close();
    server = null;
  }
  resolveCallback = null;
}

function htmlPage(title, body, success) {
  const color = success ? '#0FA870' : '#E53565';
  const icon  = success ? '✓' : '✕';
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${title} — Arie AI</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #050D18; color: #C8D9ED; display: flex; align-items: center;
           justify-content: center; height: 100vh; flex-direction: column; gap: 14px; }
    .icon { width: 56px; height: 56px; border-radius: 50%; background: ${color}22;
            border: 2px solid ${color}55; display: flex; align-items: center;
            justify-content: center; font-size: 24px; color: ${color}; }
    h2 { margin: 0; font-size: 18px; color: #fff; }
    p { margin: 0; font-size: 13px; color: #6B84A0; text-align: center; }
  </style>
</head>
<body>
  <div class="icon">${icon}</div>
  <h2>${title}</h2>
  ${body}
</body>
</html>`;
}

module.exports = { waitForOAuthCallback };
