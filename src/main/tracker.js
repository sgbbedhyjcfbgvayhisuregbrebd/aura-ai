/**
 * Arie AI — Staff Activity Tracker Service
 *
 * Runs in the Electron main process as a background service.
 * Monitors task completion against assigned tasks using AI assessment.
 * Compiles and submits an encrypted daily report at end of working day.
 *
 * Only active when workspace admin has enabled tracking for this user.
 * Private to the main process — renderer never sees raw activity data.
 */

const { ipcMain } = require('electron');
const Store       = require('electron-store');
const e2ee        = require('./e2ee');

const store = new Store({ name: 'activity-tracker' });

// ── State ──────────────────────────────────────────────────────────
let _trackingEnabled  = false;
let _workspaceId      = null;
let _userId           = null;
let _apiBase          = null;
let _authToken        = null;
let _sessionStart     = null;
let _schedulerTimer   = null;
let _activityLog      = [];   // { timestamp, type, detail }

// ── Init ───────────────────────────────────────────────────────────

/**
 * Initialise the tracker for this session.
 * Called after login once we know if tracking is enabled for this user.
 *
 * @param {object} config
 * @param {boolean} config.enabled
 * @param {string}  config.workspaceId
 * @param {string}  config.userId
 * @param {string}  config.apiBase
 * @param {string}  config.authToken
 */
function init(config) {
  _trackingEnabled = config.enabled;
  _workspaceId     = config.workspaceId;
  _userId          = config.userId;
  _apiBase         = config.apiBase;
  _authToken       = config.authToken;
  _sessionStart    = Date.now();
  _activityLog     = loadTodayLog();

  if (_trackingEnabled) {
    scheduleEndOfDay();
    console.log('[tracker] Activity tracking enabled for this session');
  }
}

/**
 * Update the auth token (called after token refresh).
 */
function updateToken(token) {
  _authToken = token;
}

/**
 * Enable or disable tracking mid-session (admin toggle change received via push/poll).
 */
function setEnabled(enabled) {
  _trackingEnabled = enabled;
  if (enabled && !_schedulerTimer) {
    scheduleEndOfDay();
  } else if (!enabled && _schedulerTimer) {
    clearTimeout(_schedulerTimer);
    _schedulerTimer = null;
  }
}

// ── Activity recording ─────────────────────────────────────────────

/**
 * Record an activity event. Called by other parts of the app.
 * Silently no-ops if tracking is disabled.
 *
 * @param {string} type    — 'task_completed'|'email_sent'|'ai_query'|'document_opened'|'login'|'logout'
 * @param {string} detail  — human-readable description (not a unique identifier — kept vague for privacy)
 */
function recordActivity(type, detail) {
  if (!_trackingEnabled) return;

  const entry = {
    timestamp: Date.now(),
    type,
    detail: sanitiseDetail(detail),
  };

  _activityLog.push(entry);
  persistTodayLog(_activityLog);
}

/**
 * Sanitise activity detail — strip any PII or sensitive content.
 * We record what TYPE of work was done, not verbatim content.
 */
function sanitiseDetail(detail) {
  if (!detail) return '';
  // Truncate, strip email addresses, phone numbers
  return detail
    .slice(0, 120)
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[email]')
    .replace(/\b\d{10,}\b/g, '[number]');
}

// ── Active hours calculation ───────────────────────────────────────

/**
 * Calculates active hours from the activity log.
 * Uses a sliding window — if there's an event within 5 minutes of the last,
 * that period counts as active. Gaps > 5 min are not counted.
 */
function calculateActiveHours(log) {
  if (log.length === 0) return 0;

  const GAP_MS = 5 * 60 * 1000; // 5 minutes
  let activeMs = 0;
  let windowStart = log[0].timestamp;
  let windowEnd   = log[0].timestamp;

  for (let i = 1; i < log.length; i++) {
    const ts = log[i].timestamp;
    if (ts - windowEnd <= GAP_MS) {
      windowEnd = ts;
    } else {
      activeMs += windowEnd - windowStart;
      windowStart = ts;
      windowEnd   = ts;
    }
  }
  activeMs += windowEnd - windowStart;

  return Math.round((activeMs / 3600000) * 10) / 10; // hours, 1dp
}

/**
 * Determines peak working hours from the activity log.
 * Returns a string like "9am–11am".
 */
function calculatePeakHours(log) {
  if (log.length < 3) return null;

  const buckets = new Array(24).fill(0);
  for (const entry of log) {
    const hour = new Date(entry.timestamp).getHours();
    buckets[hour]++;
  }

  let maxCount = 0;
  let peakHour = 9;
  for (let h = 0; h < 24; h++) {
    if (buckets[h] > maxCount) { maxCount = buckets[h]; peakHour = h; }
  }

  const fmt = h => h === 12 ? '12pm' : h > 12 ? `${h-12}pm` : `${h}am`;
  return `${fmt(peakHour)}–${fmt(peakHour + 1)}`;
}

// ── AI task assessment ─────────────────────────────────────────────

/**
 * Uses Claude to assess which assigned tasks were completed today
 * based on the activity log. Returns a list of completed task summaries.
 *
 * @param {Array} assignedTasks  — tasks from the backend assigned to this user
 * @param {Array} activityLog    — today's activity log
 * @param {string} apiKey        — user's Anthropic API key
 * @returns {Array<string>}      — list of completed task descriptions
 */
async function assessTaskCompletion(assignedTasks, activityLog, apiKey) {
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey });

  const activitySummary = activityLog
    .map(e => `${new Date(e.timestamp).toLocaleTimeString()} — ${e.type}: ${e.detail}`)
    .join('\n');

  const taskList = assignedTasks
    .map(t => `- ${t.title} (due: ${t.due_date || 'no date'}, priority: ${t.priority})`)
    .join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `Based on the activity log below, assess which of the assigned tasks were likely completed or worked on today.

Assigned tasks:
${taskList || 'No tasks assigned'}

Activity log:
${activitySummary || 'No activity recorded'}

Return JSON only: {
  "completed": ["task description 1", "task description 2"],
  "in_progress": ["task description"],
  "not_started": ["task description"],
  "summary": "One sentence summary of the day's work"
}`,
    }],
  });

  try {
    const text = response.content[0].text;
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { completed: [], in_progress: [], not_started: [], summary: 'No assessment available' };
  } catch {
    return { completed: [], in_progress: [], not_started: [], summary: 'Assessment parsing failed' };
  }
}

// ── End-of-day report ──────────────────────────────────────────────

/**
 * Compiles and submits the encrypted daily report to the backend.
 * Called automatically at end of working day (default 5:30pm).
 * Can also be called manually on logout.
 */
async function submitDailyReport(anthropicApiKey) {
  if (!_trackingEnabled || !_workspaceId) return;

  try {
    console.log('[tracker] Compiling daily report...');

    // Fetch assigned tasks from backend
    const tasksRes = await fetch(`${_apiBase}/api/tasks?assigned_to_me=true`, {
      headers: { Authorization: `Bearer ${_authToken}` },
    });
    const { tasks = [] } = tasksRes.ok ? await tasksRes.json() : {};

    // AI assessment of task completion
    const assessment = await assessTaskCompletion(_activityLog, tasks, anthropicApiKey);

    const activeHours = calculateActiveHours(_activityLog);
    const peakHours   = calculatePeakHours(_activityLog);

    const activityData = {
      tasksCompleted: assessment.completed,
      tasksInProgress: assessment.in_progress,
      tasksNotStarted: assessment.not_started,
      activeHours,
      peakHours,
      summaryText: assessment.summary,
      totalEvents: _activityLog.length,
    };

    // Fetch admin's public key for encryption
    const keyRes = await fetch(`${_apiBase}/api/keys/admin/${_workspaceId}`, {
      headers: { Authorization: `Bearer ${_authToken}` },
    });

    if (!keyRes.ok) {
      console.warn('[tracker] Admin public key not found — report not submitted');
      return;
    }

    const { encryptionPublicKey: adminPublicKey } = await keyRes.json();

    // Compile and encrypt report on-device
    const encryptedReport = await e2ee.compileDailyReport(
      activityData,
      adminPublicKey,
      _workspaceId
    );

    // POST encrypted report — backend sees only ciphertext
    const submitRes = await fetch(`${_apiBase}/api/reports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${_authToken}`,
      },
      body: JSON.stringify(encryptedReport),
    });

    if (submitRes.ok) {
      console.log('[tracker] Daily report submitted successfully');
      clearTodayLog();
    } else {
      console.error('[tracker] Report submission failed:', await submitRes.text());
    }
  } catch (err) {
    console.error('[tracker] Report compilation error:', err.message);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────

/**
 * Schedules the end-of-day report for 5:30pm local time.
 * Re-schedules itself daily.
 */
function scheduleEndOfDay() {
  if (_schedulerTimer) clearTimeout(_schedulerTimer);

  const now      = new Date();
  const eod      = new Date();
  eod.setHours(17, 30, 0, 0); // 5:30pm

  // If 5:30pm has already passed today, schedule for tomorrow
  if (now > eod) eod.setDate(eod.getDate() + 1);

  const msUntil = eod - now;
  console.log(`[tracker] End-of-day report scheduled in ${Math.round(msUntil / 60000)} minutes`);

  _schedulerTimer = setTimeout(async () => {
    // Anthropic API key fetched from safeStorage at submission time
    const { safeStorage } = require('electron');
    const Store = require('electron-store');
    const s = new Store({ name: 'arie-config' });
    const keyBlob = s.get('anthropicKeyBlob');
    const apiKey = keyBlob ? safeStorage.decryptString(Buffer.from(keyBlob)) : null;

    if (apiKey) await submitDailyReport(apiKey);
    scheduleEndOfDay(); // re-schedule for next day
  }, msUntil);
}

// ── Persistence ────────────────────────────────────────────────────

function todayKey() {
  return `log_${new Date().toISOString().slice(0, 10)}`;
}

function loadTodayLog() {
  return store.get(todayKey(), []);
}

function persistTodayLog(log) {
  store.set(todayKey(), log);
}

function clearTodayLog() {
  store.delete(todayKey());
}

// ── IPC handlers (called from renderer) ───────────────────────────

ipcMain.handle('tracker:recordActivity', (_, type, detail) => {
  recordActivity(type, detail);
});

ipcMain.handle('tracker:getStatus', () => ({
  enabled:     _trackingEnabled,
  activeHours: calculateActiveHours(_activityLog),
  eventCount:  _activityLog.length,
  peakHours:   calculatePeakHours(_activityLog),
}));

// ── Exports ────────────────────────────────────────────────────────

module.exports = {
  init,
  updateToken,
  setEnabled,
  recordActivity,
  submitDailyReport,
  calculateActiveHours,
  calculatePeakHours,
};
