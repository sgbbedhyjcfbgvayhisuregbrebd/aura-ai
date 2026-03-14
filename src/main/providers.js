// node-fetch v3 is ESM-only — use dynamic import
let _fetch;
async function getFetch() {
  if (!_fetch) { const mod = await import('node-fetch'); _fetch = mod.default; }
  return _fetch;
}
async function fetch(...args) { const f = await getFetch(); return f(...args); }

// ── Microsoft token exchange ──────────────────────────────────
async function exchangeMicrosoftCode(code, clientId, clientSecret, redirectUri) {
  const params = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    code,
    redirect_uri:  redirectUri,
    grant_type:    'authorization_code'
  });

  const res = await fetch(
    'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return data; // { access_token, refresh_token, expires_in, scope }
}

async function refreshMicrosoftToken(refreshToken, clientId, clientSecret) {
  const params = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
    scope:         'openid profile email User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite offline_access'
  });

  const res = await fetch(
    'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return data;
}

// ── Google token exchange ─────────────────────────────────────
async function exchangeGoogleCode(code, clientId, clientSecret, redirectUri) {
  const params = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    code,
    redirect_uri:  redirectUri,
    grant_type:    'authorization_code'
  });

  const res = await fetch(
    'https://oauth2.googleapis.com/token',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return data;
}

async function refreshGoogleToken(refreshToken, clientId, clientSecret) {
  const params = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type:    'refresh_token'
  });

  const res = await fetch(
    'https://oauth2.googleapis.com/token',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return data;
}

// ── Microsoft Graph API calls ─────────────────────────────────
async function getMicrosoftEmails(accessToken, top = 20) {
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages?$top=${top}&$orderby=receivedDateTime desc&$select=id,subject,from,bodyPreview,receivedDateTime,isRead,importance`,
    { headers: { Authorization: 'Bearer ' + accessToken } }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.value || [];
}

async function getMicrosoftCalendar(accessToken) {
  const now = new Date().toISOString();
  const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${now}&endDateTime=${end}&$top=20&$select=id,subject,start,end,location,attendees,isOnlineMeeting`,
    { headers: { Authorization: 'Bearer ' + accessToken } }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.value || [];
}

async function sendMicrosoftEmail(accessToken, { to, subject, body }) {
  const message = {
    message: {
      subject,
      body: { contentType: 'Text', content: body },
      toRecipients: [{ emailAddress: { address: to } }]
    }
  };
  const res = await fetch(
    'https://graph.microsoft.com/v1.0/me/sendMail',
    { method: 'POST', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify(message) }
  );
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || 'Send failed');
  }
  return { ok: true };
}

// ── Google Gmail API calls ────────────────────────────────────
async function getGoogleEmails(accessToken, maxResults = 20) {
  // Get message IDs
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}&labelIds=INBOX`,
    { headers: { Authorization: 'Bearer ' + accessToken } }
  );
  const listData = await listRes.json();
  if (listData.error) throw new Error(listData.error.message);
  if (!listData.messages) return [];

  // Fetch each message metadata in parallel (limit to 10 for speed)
  const ids = (listData.messages || []).slice(0, 10).map(m => m.id);
  const messages = await Promise.all(ids.map(async id => {
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject,From,Date`,
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    return r.json();
  }));

  return messages.map(m => {
    const headers = (m.payload?.headers || []);
    const get = (name) => headers.find(h => h.name === name)?.value || '';
    return {
      id: m.id,
      subject: get('Subject'),
      from: get('From'),
      date: get('Date'),
      snippet: m.snippet,
      isRead: !m.labelIds?.includes('UNREAD')
    };
  });
}

async function getGoogleCalendar(accessToken) {
  const now = new Date().toISOString();
  const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now}&timeMax=${end}&maxResults=20&singleEvents=true&orderBy=startTime`,
    { headers: { Authorization: 'Bearer ' + accessToken } }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.items || [];
}

// ── Apple iCloud IMAP (config only — actual IMAP needs node-imap) ──
// Returns the IMAP config object for use with node-imap
function getAppleImapConfig(email, appPassword) {
  return {
    user:     email,
    password: appPassword,
    host:     'imap.mail.me.com',
    port:     993,
    tls:      true,
    tlsOptions: { rejectUnauthorized: true }
  };
}

function getAppleCalDavConfig(email, appPassword) {
  return {
    serverUrl: 'https://caldav.icloud.com',
    credentials: {
      username: email,
      password: appPassword
    }
  };
}


async function sendGoogleEmail(accessToken, { to, subject, body }) {
  // Gmail API requires base64url-encoded RFC 2822 message
  const message = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    `MIME-Version: 1.0`,
    ``,
    body
  ].join('\r\n');

  const encoded = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  const res = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encoded })
    }
  );
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || 'Send failed');
  }
  return { ok: true };
}

module.exports = {
  exchangeMicrosoftCode,
  refreshMicrosoftToken,
  exchangeGoogleCode,
  refreshGoogleToken,
  getMicrosoftEmails,
  getMicrosoftCalendar,
  sendMicrosoftEmail,
  getGoogleEmails,
  getGoogleCalendar,
  sendGoogleEmail,
  getAppleImapConfig,
  getAppleCalDavConfig
};
