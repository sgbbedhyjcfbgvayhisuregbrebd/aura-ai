'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let currentUser  = null;
let authToken    = null;
const API_BASE   = 'http://localhost:3001';
let chatHistory  = [];

// ── API helper ────────────────────────────────────────────────────────────────
async function apiCall(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method:  opts.method || 'GET',
    headers,
    body:    opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 401) {
    doLogout();
    throw new Error('Session expired');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function initials(name) {
  return (name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

let _toastTimer;
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  el.style.borderColor = type === 'error' ? 'rgba(239,68,68,.4)' : 'var(--border)';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3000);
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openModal(title, bodyHtml) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  document.getElementById('modal-overlay').style.display = 'flex';
}
function closeModal(e) {
  if (e && e.target !== document.getElementById('modal-overlay')) return;
  document.getElementById('modal-overlay').style.display = 'none';
}

// ── Auth ──────────────────────────────────────────────────────────────────────

// Wizard state
const reg = {
  step: 1,
  email: '',
  role: '',          // 'solo' | 'ceo' | 'staff'
  inviteCode: '',
  inviteCompany: '',
  referralCode: '',
};

// Step sequence for each role
// staff:  1 → 2 → 3s → 5
// owner:  1 → 2 → 3o → 4 → 5
function regSteps() {
  if (reg.role === 'staff') return [1, 2, '3s', 5];
  return [1, 2, '3o', 4, 5];
}
function regStepIndex() { return regSteps().indexOf(reg.step); }

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

function showRegister() {
  document.getElementById('form-login').style.display    = 'none';
  document.getElementById('form-register').style.display = '';
  const switchLink = document.getElementById('auth-switch-link');
  switchLink.style.display = '';
  switchLink.innerHTML = 'Already have an account? <a href="#" onclick="showLogin()" style="color:var(--accent)">Sign in</a>';
  document.getElementById('auth-error').style.display    = 'none';
  reg.step = 1; reg.role = ''; reg.email = ''; reg.inviteCode = ''; reg.referralCode = '';
  renderRegStep();
}

function showLogin() {
  document.getElementById('form-register').style.display = 'none';
  document.getElementById('form-login').style.display    = '';
  document.getElementById('auth-switch-link').style.display = 'none';
  document.getElementById('auth-error').style.display    = 'none';
}

function renderRegStep() {
  const steps = regSteps();
  const cur   = reg.step;

  // Hide all step panels
  ['reg-step-1','reg-step-2','reg-step-3-staff','reg-step-3-owner','reg-step-4-payment','reg-step-5']
    .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });

  // Show current
  const map = { 1:'reg-step-1', 2:'reg-step-2', '3s':'reg-step-3-staff', '3o':'reg-step-3-owner', 4:'reg-step-4-payment', 5:'reg-step-5' };
  const panelId = map[cur];
  if (panelId) { const el = document.getElementById(panelId); if (el) el.style.display = ''; }

  // Show/hide company field (staff don't need company name)
  const companyField = document.getElementById('reg-company-field');
  if (companyField) companyField.style.display = reg.role === 'staff' ? 'none' : '';

  // Render step dots
  const dotsEl = document.getElementById('reg-step-dots');
  if (dotsEl) {
    dotsEl.innerHTML = steps.map((s, i) => {
      const idx = regStepIndex();
      let cls = 'reg-dot';
      if (i < idx) cls += ' done';
      if (i === idx) cls += ' active';
      return `<div class="${cls}"></div>`;
    }).join('');
  }

  showAuthError('');
}

function selectRole(role) {
  reg.role = role;
  document.querySelectorAll('.role-card').forEach(el => el.classList.remove('selected'));
  const chosen = document.getElementById(`role-${role}`);
  if (chosen) chosen.classList.add('selected');
}

async function regNext() {
  showAuthError('');
  const cur = reg.step;

  if (cur === 1) {
    const email = document.getElementById('reg-email').value.trim();
    if (!email || !email.includes('@')) return showAuthError('Please enter a valid email');
    reg.email = email;
    reg.step  = 2;
    return renderRegStep();
  }

  if (cur === 2) {
    if (!reg.role) return showAuthError('Please choose your role');
    reg.step = reg.role === 'staff' ? '3s' : '3o';
    return renderRegStep();
  }

  if (cur === '3s') {
    const code = document.getElementById('reg-invite-code').value.trim();
    if (!code || code.length !== 8) return showAuthError('Please enter your 8-digit invite code');
    // Validate code with backend
    const msgEl = document.getElementById('invite-check-msg');
    msgEl.textContent = 'Checking…'; msgEl.className = '';
    try {
      const res = await apiCall('/api/auth/invite/validate', { method: 'POST', body: { code } });
      reg.inviteCode    = code;
      reg.inviteCompany = res.companyName;
      msgEl.textContent = `✓ Joining ${res.companyName} — invited by ${res.invitedBy}`;
      msgEl.className   = 'ok';
      reg.step = 5;
      setTimeout(renderRegStep, 400);
    } catch (err) {
      msgEl.textContent = err.message;
      msgEl.className   = 'err';
    }
    return;
  }

  if (cur === '3o') {
    const ref = document.getElementById('reg-referral-code').value.trim();
    reg.referralCode = ref;
    reg.step = 4;
    return renderRegStep();
  }

  if (cur === 4) {
    reg.step = 5;
    return renderRegStep();
  }
}

function regBack() {
  const steps = regSteps();
  const idx   = regStepIndex();
  if (idx > 0) {
    reg.step = steps[idx - 1];
    renderRegStep();
  } else {
    showLogin();
  }
}

async function doLogin() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) return showAuthError('Email and password required');
  try {
    const data = await apiCall('/api/auth/login', { method: 'POST', body: { email, password } });
    authToken   = data.token;
    currentUser = data.user;
    localStorage.setItem('arie_token', authToken);
    onLoginSuccess();
  } catch (err) {
    showAuthError(err.message);
  }
}

async function doRegister() {
  const name     = document.getElementById('reg-name').value.trim();
  const password = document.getElementById('reg-password').value;
  const company  = (document.getElementById('reg-company') || {}).value?.trim() || '';
  if (!name || !password) return showAuthError('Name and password are required');
  if (password.length < 8) return showAuthError('Password must be at least 8 characters');
  try {
    const body = {
      name,
      email:        reg.email,
      password,
      accountType:  reg.role || 'solo',
      inviteCode:   reg.inviteCode  || undefined,
      referralCode: reg.referralCode || undefined,
    };
    if (reg.role !== 'staff' && company) body.companyName = company;
    const data = await apiCall('/api/auth/register', { method: 'POST', body });
    authToken   = data.token;
    currentUser = data.user;
    localStorage.setItem('arie_token', authToken);
    onLoginSuccess();
  } catch (err) {
    showAuthError(err.message);
  }
}

async function doLogout() {
  try { await apiCall('/api/auth/logout', { method: 'POST' }); } catch {}
  authToken   = null;
  currentUser = null;
  localStorage.removeItem('arie_token');
  document.getElementById('auth-screen').style.display = '';
  document.getElementById('app-shell').style.display   = 'none';
  showLogin();
}

async function onLoginSuccess() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-shell').style.display   = 'flex';
  document.getElementById('sidebar-user').textContent  = `${currentUser.name} · ${currentUser.role}`;

  try {
    const data = await apiCall('/api/auth/me');
    currentUser = { ...currentUser, ...data.user };
  } catch {}

  if (window.electronAPI) {
    try {
      const keys = await window.electronAPI.e2ee.getPublicKeys();
      if (!keys) await window.electronAPI.e2ee.generateAndRegisterKeys(currentUser.id);
    } catch {}
  }

  navTo('tasks');
}

// ── Navigation ────────────────────────────────────────────────────────────────
function navTo(page) {
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.classList.add('active');

  const navEl = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (navEl) navEl.classList.add('active');

  // Load page data
  switch (page) {
    case 'tasks':        loadTasks();         break;
    case 'projects':     loadProjects();      break;
    case 'clients':      loadClients();       break;
    case 'documents':    loadDocuments();     break;
    case 'briefings':    loadBriefings();     break;
    case 'templates':    loadTemplates();     break;
    case 'team':         loadTeam();          break;
    case 'personas':     loadPersonas();      break;
    case 'settings':     loadSettings();      break;
    case 'reports':      loadReportsPage();   break;
  }
}

// ── Tasks ─────────────────────────────────────────────────────────────────────
async function loadTasks() {
  const status      = document.getElementById('task-filter-status')?.value || '';
  const assignedMe  = document.getElementById('task-filter-assign')?.value === 'true';
  let qs = '';
  if (status)     qs += `&status=${status}`;
  if (assignedMe) qs += `&assigned_to_me=true`;

  const list = document.getElementById('task-list');
  list.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Loading…</div>';

  try {
    const { tasks } = await apiCall(`/api/tasks?${qs}`);
    if (!tasks.length) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">☑</div>No tasks yet</div>';
      return;
    }
    list.innerHTML = tasks.map(t => `
      <div class="task-item" onclick="openTaskDetail('${t.id}')">
        <div class="task-check ${t.status === 'complete' ? 'done' : ''}"
             onclick="event.stopPropagation(); toggleTask('${t.id}', '${t.status}')">
          ${t.status === 'complete' ? '✓' : ''}
        </div>
        <div style="flex:1;min-width:0">
          <div class="task-title ${t.status === 'complete' ? 'done' : ''}">${escHtml(t.title)}</div>
          ${t.due_date ? `<div class="task-meta">Due ${t.due_date.slice(0,10)}</div>` : ''}
        </div>
        ${t.priority !== 'medium' ? `<span class="badge badge-${t.priority}">${t.priority}</span>` : ''}
        ${t.assignee_name ? `<span class="task-meta">${escHtml(t.assignee_name)}</span>` : ''}
      </div>`).join('');
  } catch (err) {
    list.innerHTML = `<div style="color:var(--text-muted)">Failed to load: ${escHtml(err.message)}</div>`;
  }
}

async function toggleTask(id, currentStatus) {
  const newStatus = currentStatus === 'complete' ? 'pending' : 'complete';
  try {
    await apiCall(`/api/tasks/${id}`, { method: 'PATCH', body: { status: newStatus } });
    loadTasks();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openAddTask() {
  openModal('New Task', `
    <input class="input" id="new-task-title" placeholder="Task title">
    <input class="input" id="new-task-due" type="date" placeholder="Due date">
    <select class="input" id="new-task-priority">
      <option value="low">Low</option><option value="medium" selected>Medium</option>
      <option value="high">High</option><option value="urgent">Urgent</option>
    </select>
    <button class="btn-primary" style="margin-top:6px" onclick="submitNewTask()">Create task</button>
  `);
}
async function submitNewTask() {
  const title    = document.getElementById('new-task-title').value.trim();
  const due_date = document.getElementById('new-task-due').value;
  const priority = document.getElementById('new-task-priority').value;
  if (!title) return showToast('Title required', 'error');
  try {
    await apiCall('/api/tasks', { method: 'POST', body: { title, due_date: due_date || null, priority } });
    closeModal();
    loadTasks();
    showToast('Task created');
  } catch (err) { showToast(err.message, 'error'); }
}

function openTaskDetail(id) {
  // Fetch and show task detail in modal
  apiCall(`/api/tasks/${id}`).then(({ task }) => {
    openModal(task.title, `
      <div style="font-size:12px;color:var(--text-muted)">Status: ${task.status} · Priority: ${task.priority}</div>
      ${task.description ? `<p style="font-size:13px;margin-top:8px">${escHtml(task.description)}</p>` : ''}
      ${task.due_date ? `<div style="font-size:12px;color:var(--text-muted);margin-top:6px">Due: ${task.due_date.slice(0,10)}</div>` : ''}
      <hr>
      <button class="btn-sm" style="color:var(--red);border-color:rgba(239,68,68,.3)" onclick="deleteTask('${id}')">Delete task</button>
    `);
  });
}
async function deleteTask(id) {
  await apiCall(`/api/tasks/${id}`, { method: 'DELETE' });
  closeModal();
  loadTasks();
  showToast('Task deleted');
}

// ── Projects ──────────────────────────────────────────────────────────────────
async function loadProjects() {
  const list = document.getElementById('project-list');
  list.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Loading…</div>';
  try {
    const { projects } = await apiCall('/api/projects');
    if (!projects.length) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">📁</div>No projects yet</div>';
      return;
    }
    list.innerHTML = projects.map(p => `
      <div class="card" style="cursor:pointer" onclick="openProjectDetail('${p.id}')">
        <div class="card-title">${escHtml(p.name)}</div>
        ${p.client_name ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">Client: ${escHtml(p.client_name)}</div>` : ''}
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${p.status}</div>
      </div>`).join('');
  } catch (err) {
    list.innerHTML = `<div style="color:var(--text-muted)">${escHtml(err.message)}</div>`;
  }
}

function openAddProject() {
  openModal('New Project', `
    <input class="input" id="new-proj-name" placeholder="Project name">
    <textarea class="input" id="new-proj-desc" placeholder="Description" rows="3"></textarea>
    <button class="btn-primary" onclick="submitNewProject()">Create project</button>
  `);
}
async function submitNewProject() {
  const name = document.getElementById('new-proj-name').value.trim();
  const description = document.getElementById('new-proj-desc').value;
  if (!name) return showToast('Name required', 'error');
  try {
    await apiCall('/api/projects', { method: 'POST', body: { name, description } });
    closeModal();
    loadProjects();
    showToast('Project created');
  } catch (err) { showToast(err.message, 'error'); }
}

function openProjectDetail(id) {
  apiCall(`/api/projects/${id}`).then(({ project, tasks }) => {
    openModal(project.name, `
      <div style="font-size:12px;color:var(--text-muted)">${project.status}</div>
      ${project.description ? `<p style="font-size:13px;margin-top:8px">${escHtml(project.description)}</p>` : ''}
      <hr>
      <div style="font-size:12px;font-weight:600;margin-bottom:8px">Tasks (${tasks.length})</div>
      ${tasks.slice(0,5).map(t => `<div style="font-size:13px;padding:4px 0;color:${t.status==='complete'?'var(--text-muted)':'var(--text)'}">${t.status==='complete'?'✓ ':''} ${escHtml(t.title)}</div>`).join('')}
    `);
  });
}

// ── Clients ───────────────────────────────────────────────────────────────────
async function loadClients() {
  const list = document.getElementById('client-list');
  list.innerHTML = '';
  try {
    const { clients } = await apiCall('/api/clients');
    if (!clients.length) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">👥</div>No clients yet</div>';
      return;
    }
    list.innerHTML = clients.map(c => `
      <div class="card" style="cursor:pointer" onclick="openClientDetail('${c.id}')">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <div style="width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#1E54D4,#08B5CF);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff">${initials(c.name)}</div>
          <div class="card-title">${escHtml(c.name)}</div>
        </div>
        ${c.industry ? `<div style="font-size:12px;color:var(--text-muted)">${escHtml(c.industry)}</div>` : ''}
        ${c.email ? `<div style="font-size:12px;color:var(--text-muted)">${escHtml(c.email)}</div>` : ''}
      </div>`).join('');
  } catch (err) {
    list.innerHTML = `<div style="color:var(--text-muted)">${escHtml(err.message)}</div>`;
  }
}

function openAddClient() {
  openModal('New Client', `
    <input class="input" id="new-cl-name" placeholder="Client name">
    <input class="input" id="new-cl-email" placeholder="Email">
    <input class="input" id="new-cl-industry" placeholder="Industry">
    <textarea class="input" id="new-cl-notes" rows="3" placeholder="Notes"></textarea>
    <button class="btn-primary" onclick="submitNewClient()">Create client</button>
  `);
}
async function submitNewClient() {
  const name = document.getElementById('new-cl-name').value.trim();
  if (!name) return showToast('Name required', 'error');
  try {
    await apiCall('/api/clients', { method: 'POST', body: {
      name,
      email: document.getElementById('new-cl-email').value,
      industry: document.getElementById('new-cl-industry').value,
      notes: document.getElementById('new-cl-notes').value,
    }});
    closeModal();
    loadClients();
    showToast('Client created');
  } catch (err) { showToast(err.message, 'error'); }
}

function openClientDetail(id) {
  apiCall(`/api/clients/${id}`).then(({ client, projects, memories }) => {
    openModal(client.name, `
      ${client.email ? `<div style="font-size:13px">${escHtml(client.email)}</div>` : ''}
      ${client.industry ? `<div style="font-size:12px;color:var(--text-muted)">${escHtml(client.industry)}</div>` : ''}
      ${client.notes ? `<div style="font-size:13px;margin-top:8px">${escHtml(client.notes)}</div>` : ''}
      <hr>
      <div style="font-size:12px;font-weight:600;margin-bottom:6px">Projects (${projects.length})</div>
      ${projects.map(p => `<div style="font-size:13px;padding:3px 0">${escHtml(p.name)}</div>`).join('') || '<div style="font-size:12px;color:var(--text-muted)">None</div>'}
      <hr>
      <div style="font-size:12px;font-weight:600;margin-bottom:6px">Memories</div>
      ${memories.slice(0,3).map(m => `<div style="font-size:12px;color:var(--text-muted);padding:3px 0">${escHtml(m.content)}</div>`).join('') || '<div style="font-size:12px;color:var(--text-muted)">None</div>'}
    `);
  });
}

// ── Chat ──────────────────────────────────────────────────────────────────────
function chatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
}

async function sendChat() {
  const input   = document.getElementById('chat-input');
  const content = input.value.trim();
  if (!content) return;
  input.value = '';

  chatHistory.push({ role: 'user', content });
  renderChatMessages();

  const thinkingId = 'thinking-' + Date.now();
  document.getElementById('chat-messages').insertAdjacentHTML('beforeend',
    `<div id="${thinkingId}" class="chat-msg arie"><div class="chat-bubble" style="color:var(--text-muted)">Thinking…</div></div>`);

  try {
    const { content: reply } = await apiCall('/api/ai/chat', { method: 'POST', body: { messages: chatHistory } });
    chatHistory.push({ role: 'assistant', content: reply });
    document.getElementById(thinkingId)?.remove();
    renderChatMessages();
  } catch (err) {
    document.getElementById(thinkingId)?.remove();
    showToast(err.message, 'error');
  }
}

function renderChatMessages() {
  const container = document.getElementById('chat-messages');
  container.innerHTML = chatHistory.map(m => `
    <div class="chat-msg ${m.role === 'user' ? 'user' : 'arie'}">
      <div class="chat-bubble">${escHtml(m.content).replace(/\n/g,'<br>')}</div>
    </div>`).join('');
  container.scrollTop = container.scrollHeight;
}

// ── Email Intel ───────────────────────────────────────────────────────────────
async function triageEmails() {
  const text = document.getElementById('email-input').value.trim();
  if (!text) return showToast('Paste at least one email', 'error');
  const results = document.getElementById('triage-results');
  results.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Analysing…</div>';
  try {
    const { triage } = await apiCall('/api/email-intel/triage', {
      method: 'POST',
      body: { emails: [{ id: '1', content: text }] },
    });
    results.innerHTML = triage.map(t => `
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <span class="badge badge-${t.priority}">${t.priority}</span>
          <span style="font-size:12px;color:var(--text-muted)">${escHtml(t.category || '')}</span>
          ${t.reply_needed ? '<span style="font-size:11px;color:var(--orange)">⚡ Reply needed</span>' : ''}
        </div>
        <div style="font-size:13px">${escHtml(t.summary || '')}</div>
        ${t.suggested_action ? `<div style="font-size:12px;color:var(--accent);margin-top:8px">→ ${escHtml(t.suggested_action)}</div>` : ''}
        <button class="btn-sm" style="margin-top:10px" onclick="draftReply(\`${escHtml(text)}\`)">Draft reply</button>
      </div>`).join('');
  } catch (err) { results.innerHTML = `<div style="color:var(--text-muted)">${escHtml(err.message)}</div>`; }
}

async function draftReply(original) {
  openModal('Draft Reply', `<div style="color:var(--text-muted);font-size:13px">Generating…</div>`);
  try {
    const { draft } = await apiCall('/api/email-intel/draft-reply', { method: 'POST', body: { originalEmail: original } });
    document.getElementById('modal-body').innerHTML = `
      <textarea class="input" rows="12" id="reply-draft-text">${escHtml(draft)}</textarea>
      <button class="btn-sm" onclick="copyDraft()">Copy to clipboard</button>`;
  } catch (err) {
    document.getElementById('modal-body').innerHTML = `<div style="color:var(--text-muted)">${escHtml(err.message)}</div>`;
  }
}
function copyDraft() {
  const text = document.getElementById('reply-draft-text')?.value;
  if (text) navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard'));
}

// ── Documents ─────────────────────────────────────────────────────────────────
async function loadDocuments() {
  const list = document.getElementById('doc-list');
  list.innerHTML = '';
  try {
    const { documents } = await apiCall('/api/documents');
    if (!documents.length) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">📄</div>No documents yet. Upload one to get started.</div>';
      return;
    }
    list.innerHTML = documents.map(d => `
      <div class="card" style="cursor:pointer" onclick="openDocDetail('${d.id}')">
        <div class="card-title">${escHtml(d.name)}</div>
        ${d.summary ? `<div style="font-size:12px;color:var(--text-muted);margin-top:6px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical">${escHtml(d.summary)}</div>` : ''}
        <div style="font-size:11px;color:var(--text-muted);margin-top:8px">${d.created_at?.slice(0,10) || ''}</div>
      </div>`).join('');
  } catch (err) { list.innerHTML = `<div style="color:var(--text-muted)">${escHtml(err.message)}</div>`; }
}

async function uploadDocument() {
  if (window.electronAPI) {
    const filePath = await window.electronAPI.dialog.openFile();
    if (!filePath) return;
    showToast('Uploading…');
    // Electron IPC file upload — read file via fetch from file:// URL is not allowed,
    // so we signal the main process via IPC (simplified — in production use form data)
    showToast('File selected. Use web version to upload files.', 'error');
  } else {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.docx,.txt,.md';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      showToast('Uploading…');
      const res = await fetch(`${API_BASE}/api/documents/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: fd,
      });
      if (res.ok) { loadDocuments(); showToast('Document uploaded'); }
      else showToast('Upload failed', 'error');
    };
    input.click();
  }
}

function openDocDetail(id) {
  apiCall(`/api/documents`).then(({ documents }) => {
    const doc = documents.find(d => d.id === id);
    if (!doc) return;
    openModal(doc.name, `
      ${doc.summary ? `<div style="font-size:13px;line-height:1.6">${escHtml(doc.summary)}</div><hr>` : ''}
      <div style="display:flex;gap:10px">
        <button class="btn-sm" onclick="summariseDoc('${id}')">Summarise</button>
        <button class="btn-sm" onclick="chatWithDoc('${id}', '${escHtml(doc.name)}')">Chat with doc</button>
      </div>
    `);
  });
}
async function summariseDoc(id) {
  document.getElementById('modal-body').innerHTML = '<div style="color:var(--text-muted)">Summarising…</div>';
  try {
    const { summary } = await apiCall(`/api/documents/${id}/summarise`, { method: 'POST' });
    document.getElementById('modal-body').innerHTML = `<div style="font-size:13px;line-height:1.7">${escHtml(summary).replace(/\n/g,'<br>')}</div>`;
    loadDocuments();
  } catch (err) {
    document.getElementById('modal-body').innerHTML = `<div style="color:var(--text-muted)">${escHtml(err.message)}</div>`;
  }
}
async function chatWithDoc(id, name) {
  openModal(`Chat: ${name}`, `
    <div id="doc-chat-msgs" style="min-height:120px;max-height:300px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;margin-bottom:10px"></div>
    <div style="display:flex;gap:8px">
      <input class="input" id="doc-chat-input" placeholder="Ask a question about this document…" style="flex:1" onkeydown="if(event.key==='Enter') sendDocChat('${id}')">
      <button class="btn-sm" onclick="sendDocChat('${id}')">Ask</button>
    </div>
  `);
}
const docChatHistory = {};
async function sendDocChat(docId) {
  const input = document.getElementById('doc-chat-input');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  if (!docChatHistory[docId]) docChatHistory[docId] = [];
  docChatHistory[docId].push({ role: 'user', content: q });
  const msgs = document.getElementById('doc-chat-msgs');
  msgs.insertAdjacentHTML('beforeend', `<div style="align-self:flex-end;background:rgba(30,111,212,.2);border-radius:7px;padding:7px 10px;font-size:13px">${escHtml(q)}</div>`);
  try {
    const { content } = await apiCall(`/api/documents/${docId}/chat`, { method: 'POST', body: { messages: docChatHistory[docId] } });
    docChatHistory[docId].push({ role: 'assistant', content });
    msgs.insertAdjacentHTML('beforeend', `<div style="background:var(--surface-2);border-radius:7px;padding:7px 10px;font-size:13px">${escHtml(content).replace(/\n/g,'<br>')}</div>`);
    msgs.scrollTop = msgs.scrollHeight;
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Briefings ─────────────────────────────────────────────────────────────────
async function loadBriefings() {
  const list = document.getElementById('briefing-list');
  list.innerHTML = '';
  try {
    const { briefings } = await apiCall('/api/briefings');
    if (!briefings.length) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div>No briefings yet</div>';
      return;
    }
    list.innerHTML = briefings.map(b => `
      <div class="card" style="margin-bottom:12px;cursor:pointer" onclick="openBriefingDetail('${b.id}')">
        <div class="card-title">${escHtml(b.title)}</div>
        ${b.meeting_time ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${escHtml(b.meeting_time)}</div>` : ''}
      </div>`).join('');
  } catch (err) { list.innerHTML = `<div style="color:var(--text-muted)">${escHtml(err.message)}</div>`; }
}

function openAddBriefing() {
  openModal('Generate Briefing', `
    <input class="input" id="brief-title" placeholder="Meeting title">
    <input class="input" id="brief-time" placeholder="Meeting time (e.g. 10 March 2 PM)" style="margin-top:8px">
    <input class="input" id="brief-attendees" placeholder="Attendees" style="margin-top:8px">
    <textarea class="input" id="brief-context" rows="4" placeholder="Context / agenda / objectives" style="margin-top:8px"></textarea>
    <button class="btn-primary" style="margin-top:8px" onclick="submitBriefing()">Generate with AI</button>
  `);
}
async function submitBriefing() {
  const title     = document.getElementById('brief-title').value.trim();
  const meetingTime = document.getElementById('brief-time').value;
  const attendees = document.getElementById('brief-attendees').value;
  const context   = document.getElementById('brief-context').value;
  if (!title) return showToast('Title required', 'error');
  document.getElementById('modal-body').innerHTML = '<div style="color:var(--text-muted)">Generating briefing…</div>';
  try {
    const { briefing } = await apiCall('/api/briefings/generate', { method: 'POST', body: { title, meetingTime, attendees, context } });
    closeModal();
    loadBriefings();
    showToast('Briefing created');
  } catch (err) { showToast(err.message, 'error'); }
}

function openBriefingDetail(id) {
  apiCall('/api/briefings').then(({ briefings }) => {
    const b = briefings.find(x => x.id === id);
    if (!b) return;
    openModal(b.title, `
      <div style="font-size:13px;line-height:1.7;white-space:pre-wrap">${escHtml(b.briefing)}</div>
      <hr>
      <button class="btn-sm" onclick="copyBriefing(\`${escHtml(b.briefing)}\`)">Copy to clipboard</button>
      <button class="btn-sm" style="margin-left:8px;color:var(--red);border-color:rgba(239,68,68,.3)" onclick="deleteBriefing('${id}')">Delete</button>
    `);
  });
}
async function deleteBriefing(id) {
  await apiCall(`/api/briefings/${id}`, { method: 'DELETE' });
  closeModal();
  loadBriefings();
}
function copyBriefing(text) {
  navigator.clipboard.writeText(text).then(() => showToast('Copied'));
}

// ── Templates ─────────────────────────────────────────────────────────────────
async function loadTemplates() {
  const list = document.getElementById('template-list');
  list.innerHTML = '';
  try {
    const { templates } = await apiCall('/api/templates');
    if (!templates.length) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">🗃</div>No templates yet</div>';
      return;
    }
    list.innerHTML = templates.map(t => `
      <div class="card" style="cursor:pointer" onclick="openTemplate('${t.id}')">
        <div class="card-title">${escHtml(t.name)}</div>
        ${t.category ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${escHtml(t.category)}</div>` : ''}
      </div>`).join('');
  } catch (err) { list.innerHTML = `<div style="color:var(--text-muted)">${escHtml(err.message)}</div>`; }
}

function openAddTemplate() {
  openModal('New Template', `
    <input class="input" id="new-tmpl-name" placeholder="Template name">
    <input class="input" id="new-tmpl-cat" placeholder="Category" style="margin-top:8px">
    <textarea class="input" id="new-tmpl-content" rows="8" placeholder="Template content…" style="margin-top:8px;font-family:monospace;font-size:12px"></textarea>
    <button class="btn-primary" style="margin-top:8px" onclick="submitTemplate()">Save template</button>
  `);
}
async function submitTemplate() {
  const name     = document.getElementById('new-tmpl-name').value.trim();
  const category = document.getElementById('new-tmpl-cat').value;
  const content  = document.getElementById('new-tmpl-content').value;
  if (!name || !content) return showToast('Name and content required', 'error');
  try {
    await apiCall('/api/templates', { method: 'POST', body: { name, category, content } });
    closeModal();
    loadTemplates();
    showToast('Template saved');
  } catch (err) { showToast(err.message, 'error'); }
}

function openTemplate(id) {
  apiCall('/api/templates').then(({ templates }) => {
    const t = templates.find(x => x.id === id);
    if (!t) return;
    openModal(t.name, `
      <pre style="font-size:12px;color:var(--text);line-height:1.6;white-space:pre-wrap;font-family:var(--font-mono)">${escHtml(t.content)}</pre>
      <button class="btn-sm" onclick="navigator.clipboard.writeText(document.querySelector('#modal-body pre').textContent).then(()=>showToast('Copied'))">Copy</button>
    `);
  });
}

// ── Productivity ──────────────────────────────────────────────────────────────
async function getFocusPlan() {
  showProductivity('Generating focus plan…');
  try {
    const { focusPlan } = await apiCall('/api/productivity/focus');
    showProductivity(focusPlan);
  } catch (err) { showProductivity(err.message); }
}
async function getDebrief() {
  showProductivity('Generating debrief…');
  try {
    const { debrief } = await apiCall('/api/productivity/debrief');
    showProductivity(debrief);
  } catch (err) { showProductivity(err.message); }
}
async function getWeeklyReview() {
  showProductivity('Generating weekly review…');
  try {
    const { review } = await apiCall('/api/productivity/weekly-review');
    showProductivity(review);
  } catch (err) { showProductivity(err.message); }
}
function showProductivity(text) {
  const el = document.getElementById('productivity-output');
  el.style.display = 'block';
  el.innerHTML = `<div style="font-size:13px;line-height:1.7;white-space:pre-wrap">${escHtml(text).replace(/\n/g,'<br>')}</div>`;
}

// ── Team ──────────────────────────────────────────────────────────────────────
async function loadTeam() {
  const list = document.getElementById('team-members');
  list.innerHTML = '';
  try {
    const { members } = await apiCall('/api/teamwork/members');
    if (!members.length) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">🤝</div>No team members yet</div>';
      return;
    }
    list.innerHTML = members.map(m => `
      <div class="card">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <div style="width:32px;height:32px;border-radius:8px;background:${m.avatar_color || 'linear-gradient(135deg,#1E54D4,#08B5CF)'};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff">${initials(m.name)}</div>
          <div><div style="font-weight:600;font-size:13px">${escHtml(m.name)}</div><div style="font-size:11px;color:var(--text-muted)">${escHtml(m.role)}</div></div>
        </div>
        <div style="display:flex;gap:16px;font-size:12px;color:var(--text-muted)">
          <div><span style="font-weight:600;color:var(--text)">${m.open_tasks}</span> open tasks</div>
          <div><span style="font-weight:600;color:var(--green)">${m.done_this_week}</span> done this week</div>
        </div>
      </div>`).join('');
  } catch (err) { list.innerHTML = `<div style="color:var(--text-muted)">${escHtml(err.message)}</div>`; }
}

// ── Reports (placeholder — actual impl in reports-dashboard.html fragment) ────
async function loadReportsPage() {
  const page = document.getElementById('page-reports');
  page.innerHTML = '<div class="page-header"><div class="page-title">Staff Reports</div><div class="page-sub">E2EE encrypted reports — admin only</div></div><div class="empty-state"><div class="empty-icon">📊</div>Reports are viewed through the workspace dashboard.</div>';
}

// ── Personas ──────────────────────────────────────────────────────────────────
async function loadPersonas() {
  const list = document.getElementById('persona-list');
  list.innerHTML = '';
  try {
    const { personas } = await apiCall('/api/personas');
    if (!personas.length) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">🎭</div>No personas yet</div>';
      return;
    }
    list.innerHTML = personas.map(p => `
      <div class="card" style="${p.is_personal_default ? 'border-color:rgba(30,111,212,.4)' : ''}">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <div class="card-title">${escHtml(p.name)}</div>
          ${p.is_personal_default ? '<span style="font-size:10px;color:var(--accent)">ACTIVE</span>' : ''}
        </div>
        <div style="font-size:12px;color:var(--text-muted)">${p.tone} · ${p.formality}</div>
        ${p.description ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${escHtml(p.description)}</div>` : ''}
        <div style="display:flex;gap:8px;margin-top:10px">
          ${!p.is_personal_default ? `<button class="btn-sm" onclick="activatePersona(${p.id})">Activate</button>` : ''}
          <button class="btn-sm" style="color:var(--red);border-color:rgba(239,68,68,.3)" onclick="deletePersona(${p.id})">Delete</button>
        </div>
      </div>`).join('');
  } catch (err) { list.innerHTML = `<div style="color:var(--text-muted)">${escHtml(err.message)}</div>`; }
}

function openAddPersona() {
  openModal('New Persona', `
    <input class="input" id="new-pers-name" placeholder="Persona name">
    <select class="input" id="new-pers-tone" style="margin-top:8px">
      <option>professional</option><option>assertive</option><option>empathetic</option><option>conversational</option>
    </select>
    <select class="input" id="new-pers-form" style="margin-top:8px">
      <option value="formal" selected>Formal</option><option value="semi-formal">Semi-formal</option><option value="casual">Casual</option>
    </select>
    <input class="input" id="new-pers-signoff" placeholder="Sign-off (e.g. Best regards)" style="margin-top:8px">
    <label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px;cursor:pointer">
      <input type="checkbox" id="new-pers-default"> Set as default
    </label>
    <button class="btn-primary" style="margin-top:10px" onclick="submitPersona()">Create persona</button>
  `);
}
async function submitPersona() {
  const name = document.getElementById('new-pers-name').value.trim();
  if (!name) return showToast('Name required', 'error');
  try {
    await apiCall('/api/personas', { method: 'POST', body: {
      name,
      tone:               document.getElementById('new-pers-tone').value,
      formality:          document.getElementById('new-pers-form').value,
      signoff:            document.getElementById('new-pers-signoff').value,
      is_personal_default: document.getElementById('new-pers-default').checked,
    }});
    closeModal();
    loadPersonas();
    showToast('Persona created');
  } catch (err) { showToast(err.message, 'error'); }
}
async function activatePersona(id) {
  try {
    await apiCall(`/api/personas/activate/${id}`, { method: 'PATCH' });
    loadPersonas();
    showToast('Persona activated');
  } catch (err) { showToast(err.message, 'error'); }
}
async function deletePersona(id) {
  try {
    await apiCall(`/api/personas/${id}`, { method: 'DELETE' });
    loadPersonas();
    showToast('Persona deleted');
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Settings ──────────────────────────────────────────────────────────────────
function loadSettings() {
  const info = document.getElementById('settings-user-info');
  if (currentUser) {
    const accountLabel = currentUser.account_type ? ` · ${currentUser.account_type}` : '';
    info.innerHTML = `<div style="font-weight:600">${escHtml(currentUser.name)}</div><div>${escHtml(currentUser.email)}</div><div style="margin-top:4px;color:var(--text-muted)">${escHtml(currentUser.role)}${accountLabel}</div>`;
  }

  // Show invite codes section for account owners (Directors who are CEO or Solo)
  const isOwner = currentUser && currentUser.account_type !== 'staff' && currentUser.role === 'Director';
  const inviteCard = document.getElementById('invite-codes-card');
  if (inviteCard) {
    inviteCard.style.display = isOwner ? '' : 'none';
    if (isOwner) loadInviteCodes();
  }
}

async function loadInviteCodes() {
  const hist = document.getElementById('invite-codes-history');
  if (!hist) return;
  try {
    const codes = await apiCall('/api/auth/invite/my-codes');
    if (!codes.length) { hist.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">No codes generated yet.</div>'; return; }
    hist.innerHTML = `
      <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Previous codes</div>
      ${codes.map(c => `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <span style="font-family:var(--font-mono);font-size:15px;letter-spacing:.15em;color:${c.used_by ? 'var(--text-muted)' : 'var(--text)'}">${escHtml(c.code)}</span>
          <span style="font-size:11px;padding:2px 8px;border-radius:10px;background:${c.used_by ? 'rgba(107,107,112,.15)' : 'rgba(34,197,94,.12)'};color:${c.used_by ? 'var(--text-muted)' : 'var(--green)'}">
            ${c.used_by ? `Used by ${escHtml(c.used_by_name || 'staff')}` : 'Available'}
          </span>
        </div>`).join('')}`;
  } catch {}
}

async function generateStaffInviteCode() {
  const result = document.getElementById('invite-code-result');
  try {
    const data = await apiCall('/api/auth/invite/generate', { method: 'POST' });
    result.innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Share this code with your new staff member:</div>
      <div class="invite-code-display">${escHtml(data.code)}</div>
      <div style="font-size:11px;color:var(--text-muted)">Valid for one use only. Tell them to select "Staff" when signing up.</div>`;
    loadInviteCodes();
  } catch (err) { showToast(err.message, 'error'); }
}

async function changePassword() {
  const cur = document.getElementById('settings-cur-pass').value;
  const nw  = document.getElementById('settings-new-pass').value;
  if (!cur || !nw) return showToast('Both fields required', 'error');
  try {
    const { token } = await apiCall('/api/auth/change-password', { method: 'POST', body: { currentPassword: cur, newPassword: nw } });
    authToken = token;
    localStorage.setItem('arie_token', token);
    showToast('Password updated');
  } catch (err) { showToast(err.message, 'error'); }
}

async function generateE2EEKeys() {
  if (!window.electronAPI) return showToast('E2EE keys only available in the desktop app', 'error');
  try {
    await window.electronAPI.e2ee.generateAndRegisterKeys(currentUser.id);
    showToast('E2EE keys generated and registered');
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  const savedToken = localStorage.getItem('arie_token');
  if (savedToken) {
    authToken = savedToken;
    try {
      const { user } = await apiCall('/api/auth/me');
      currentUser = user;
      onLoginSuccess();
    } catch {
      authToken = null;
      localStorage.removeItem('arie_token');
    }
  }
})();

// ══════════════════════════════════════════════════════════════════════════════
// PROSPECTS — Lead Pipeline & AI Qualification
// ══════════════════════════════════════════════════════════════════════════════

const GRADE_COLOURS = { A:'#22c55e', B:'#f59e0b', C:'#f97316', D:'#ef4444' };
const STATUS_LABELS = { new:'New', contacted:'Contacted', qualified:'Qualified', proposal:'Proposal', won:'Won ✓', lost:'Lost' };

async function loadProspects() {
  const status = document.getElementById('prospect-filter-status').value;
  const grade  = document.getElementById('prospect-filter-grade').value;
  const search = document.getElementById('prospect-search').value;

  let url = '/api/prospects?sort=created_at&order=DESC';
  if (status) url += `&status=${status}`;
  if (grade)  url += `&grade=${grade}`;
  if (search) url += `&search=${encodeURIComponent(search)}`;

  try {
    const leads = await apiCall(url);
    renderProspects(leads);
    loadProspectStats();
  } catch (err) { showToast(err.message, 'error'); }
}

async function loadProspectStats() {
  try {
    const stats = await apiCall('/api/prospects/stats');
    const el = document.getElementById('prospect-stats');
    el.innerHTML = `
      <div class="stat-card"><div class="stat-value">${stats.total}</div><div class="stat-label">Total leads</div></div>
      <div class="stat-card"><div class="stat-value">${stats.qualified}</div><div class="stat-label">Qualified (70+)</div></div>
      <div class="stat-card"><div class="stat-value">$${(stats.pipeline/1000).toFixed(0)}k</div><div class="stat-label">Pipeline value</div></div>
      <div class="stat-card"><div class="stat-value">${(stats.byGrade.find(g=>g.ai_grade==='A')?.n)||0}</div><div class="stat-label">Grade A leads</div></div>
    `;
  } catch {}
}

function renderProspects(leads) {
  const el = document.getElementById('prospect-list');
  if (!leads.length) {
    el.innerHTML = `<div class="empty-state">No leads yet. Click <strong>+ Add lead</strong> to get started.</div>`;
    return;
  }
  el.innerHTML = leads.map(l => {
    const gradeColor = l.ai_grade ? GRADE_COLOURS[l.ai_grade] : 'var(--text-muted)';
    const scoreBar   = l.ai_score != null
      ? `<div style="height:4px;background:var(--border);border-radius:2px;margin-top:6px;overflow:hidden">
           <div style="height:100%;width:${l.ai_score}%;background:${gradeColor};border-radius:2px;transition:width .4s"></div>
         </div>`
      : '';
    return `
      <div class="card" style="margin-bottom:10px;cursor:pointer" onclick="openProspect('${l.id}')">
        <div style="display:flex;align-items:flex-start;gap:14px">
          <div style="width:42px;height:42px;border-radius:10px;background:${gradeColor}22;border:1.5px solid ${gradeColor}44;display:flex;align-items:center;justify-content:center;font-family:var(--font-head);font-size:17px;font-weight:800;color:${gradeColor};flex-shrink:0">
            ${l.ai_grade || '?'}
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:14px">${l.name}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${l.company||''}${l.industry?' · '+l.industry:''}</div>
            ${l.ai_summary ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px;line-height:1.5">${l.ai_summary}</div>` : ''}
            ${scoreBar}
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0">
            <span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--surface-2);color:var(--text-muted)">${STATUS_LABELS[l.status]||l.status}</span>
            ${l.estimated_value ? `<span style="font-size:12px;font-weight:600;color:var(--text)">$${Number(l.estimated_value).toLocaleString()}</span>` : ''}
            ${l.ai_score != null ? `<span style="font-size:11px;color:${gradeColor}">Score: ${l.ai_score}/100</span>` : ''}
          </div>
        </div>
        ${l.ai_next_action ? `<div style="margin-top:10px;padding:8px 10px;border-radius:7px;background:var(--surface-2);font-size:12px;color:var(--text-muted)">
          <strong style="color:var(--text)">Next action:</strong> ${l.ai_next_action}
        </div>` : ''}
      </div>
    `;
  }).join('');
}

function openAddProspect() {
  openModal('Add Lead', `
    <div style="display:flex;flex-direction:column;gap:10px">
      <input class="input" id="np-name"     placeholder="Full name *">
      <input class="input" id="np-company"  placeholder="Company">
      <input class="input" id="np-email"    placeholder="Email address" type="email">
      <input class="input" id="np-phone"    placeholder="Phone number">
      <input class="input" id="np-website"  placeholder="Website">
      <select class="input" id="np-industry">
        <option value="">Industry</option>
        <option>Legal</option><option>Finance</option><option>Real Estate</option>
        <option>Consulting</option><option>Technology</option><option>Healthcare</option><option>Other</option>
      </select>
      <select class="input" id="np-source">
        <option value="">Source</option>
        <option>Referral</option><option>LinkedIn</option><option>Website</option>
        <option>Event</option><option>Cold outreach</option><option>Other</option>
      </select>
      <input class="input" id="np-value" placeholder="Estimated deal value ($)" type="number">
      <textarea class="input" id="np-notes" placeholder="Notes" rows="3"></textarea>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn-sm" onclick="saveNewProspect()" style="flex:1">Add lead</button>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
          <input type="checkbox" id="np-qualify"> Run AI qualification
        </label>
      </div>
    </div>
  `);
}

async function saveNewProspect() {
  const name = document.getElementById('np-name').value.trim();
  if (!name) return showToast('Name is required', 'error');
  try {
    const lead = await apiCall('/api/prospects', { method:'POST', body:{
      name,
      company:  document.getElementById('np-company').value,
      email:    document.getElementById('np-email').value,
      phone:    document.getElementById('np-phone').value,
      website:  document.getElementById('np-website').value,
      industry: document.getElementById('np-industry').value,
      source:   document.getElementById('np-source').value,
      notes:    document.getElementById('np-notes').value,
      estimatedValue: document.getElementById('np-value').value || null,
    }});
    closeModal();
    if (document.getElementById('np-qualify').checked) {
      await qualifyProspect(lead.id);
    }
    showToast('Lead added');
    loadProspects();
  } catch (err) { showToast(err.message, 'error'); }
}

async function openProspect(id) {
  try {
    const l = await apiCall(`/api/prospects/${id}`);
    const gradeColor = l.ai_grade ? GRADE_COLOURS[l.ai_grade] : 'var(--text-muted)';
    const strengths  = l.ai_strengths ? JSON.parse(l.ai_strengths) : [];
    const risks      = l.ai_risks     ? JSON.parse(l.ai_risks)     : [];

    openModal(l.name, `
      <div style="display:flex;flex-direction:column;gap:14px">

        <!-- Score header -->
        ${l.ai_score != null ? `
          <div style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:10px;background:${gradeColor}11;border:1px solid ${gradeColor}33">
            <div style="width:52px;height:52px;border-radius:12px;background:${gradeColor}22;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;color:${gradeColor};flex-shrink:0">${l.ai_grade}</div>
            <div style="flex:1">
              <div style="font-size:13px;font-weight:600;color:var(--text)">AI Score: ${l.ai_score}/100</div>
              <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${l.ai_summary||''}</div>
              <div style="height:4px;background:var(--border);border-radius:2px;margin-top:6px;overflow:hidden">
                <div style="height:100%;width:${l.ai_score}%;background:${gradeColor};border-radius:2px"></div>
              </div>
            </div>
          </div>` : ''}

        <!-- Details -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px">
          ${l.company  ? `<div><span style="color:var(--text-muted)">Company</span><br><strong>${l.company}</strong></div>` : ''}
          ${l.industry ? `<div><span style="color:var(--text-muted)">Industry</span><br><strong>${l.industry}</strong></div>` : ''}
          ${l.email    ? `<div><span style="color:var(--text-muted)">Email</span><br><a href="mailto:${l.email}" style="color:var(--accent)">${l.email}</a></div>` : ''}
          ${l.phone    ? `<div><span style="color:var(--text-muted)">Phone</span><br><strong>${l.phone}</strong></div>` : ''}
          ${l.source   ? `<div><span style="color:var(--text-muted)">Source</span><br><strong>${l.source}</strong></div>` : ''}
          ${l.estimated_value ? `<div><span style="color:var(--text-muted)">Est. value</span><br><strong>$${Number(l.estimated_value).toLocaleString()}</strong></div>` : ''}
        </div>

        <!-- Strengths & risks -->
        ${strengths.length ? `<div>
          <div style="font-size:11px;font-weight:700;color:#22c55e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Strengths</div>
          ${strengths.map(s=>`<div style="font-size:12px;padding:5px 0;border-bottom:1px solid var(--border);color:var(--text-muted)">✓ ${s}</div>`).join('')}
        </div>` : ''}
        ${risks.length ? `<div>
          <div style="font-size:11px;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Risks</div>
          ${risks.map(r=>`<div style="font-size:12px;padding:5px 0;border-bottom:1px solid var(--border);color:var(--text-muted)">⚠ ${r}</div>`).join('')}
        </div>` : ''}

        <!-- Next action -->
        ${l.ai_next_action ? `<div style="padding:10px 12px;border-radius:8px;background:var(--surface-2);font-size:13px">
          <strong>Next action:</strong> ${l.ai_next_action}
        </div>` : ''}

        <!-- Notes -->
        ${l.notes ? `<div style="font-size:13px;color:var(--text-muted)">${l.notes}</div>` : ''}

        <!-- Status change + actions -->
        <div style="display:flex;gap:8px;flex-wrap:wrap;padding-top:4px">
          <select class="input" id="prospect-status-sel" style="flex:1;min-width:120px" onchange="updateProspectStatus('${l.id}', this.value)">
            ${Object.entries(STATUS_LABELS).map(([v,label])=>`<option value="${v}"${l.status===v?' selected':''}>${label}</option>`).join('')}
          </select>
          <button class="btn-sm" onclick="qualifyProspect('${l.id}')">🤖 Qualify with AI</button>
          <button class="btn-sm" style="background:rgba(239,68,68,.15);color:#ef4444" onclick="deleteProspect('${l.id}')">Delete</button>
        </div>
      </div>
    `);
  } catch (err) { showToast(err.message, 'error'); }
}

async function qualifyProspect(id) {
  showToast('Running AI qualification...');
  try {
    const result = await apiCall(`/api/prospects/${id}/qualify`, { method:'POST' });
    closeModal();
    showToast(`Qualified — Grade ${result.grade}, Score ${result.score}/100`);
    loadProspects();
    // Reopen with updated data
    setTimeout(() => openProspect(id), 300);
  } catch (err) { showToast(err.message, 'error'); }
}

async function updateProspectStatus(id, status) {
  try {
    await apiCall(`/api/prospects/${id}`, { method:'PATCH', body:{ status } });
    showToast('Status updated');
    loadProspects();
  } catch (err) { showToast(err.message, 'error'); }
}

async function deleteProspect(id) {
  if (!confirm('Delete this lead? This cannot be undone.')) return;
  try {
    await apiCall(`/api/prospects/${id}`, { method:'DELETE' });
    closeModal();
    showToast('Lead deleted');
    loadProspects();
  } catch (err) { showToast(err.message, 'error'); }
}

function openImportProspects() {
  openModal('Import Leads (CSV)', `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="font-size:13px;color:var(--text-muted);line-height:1.6">
        Paste CSV with headers: <code>name,company,email,phone,industry,source</code><br>
        First row should be the header row.
      </div>
      <textarea class="input" id="import-csv" rows="10" placeholder="name,company,email,phone,industry,source
John Smith,Acme Corp,john@acme.com,0400000000,Legal,Referral
Jane Doe,XYZ Ltd,jane@xyz.com,,,Consulting,LinkedIn"></textarea>
      <button class="btn-sm" onclick="doImportProspects()">Import leads →</button>
    </div>
  `);
}

async function doImportProspects() {
  const csv = document.getElementById('import-csv').value.trim();
  if (!csv) return showToast('Paste CSV data first', 'error');
  try {
    const { imported } = await apiCall('/api/prospects/import', { method:'POST', body:{ csv } });
    closeModal();
    showToast(`Imported ${imported} leads`);
    loadProspects();
  } catch (err) { showToast(err.message, 'error'); }
}

// Load prospects when navigating to the page
const _origNavTo = typeof navTo === 'function' ? navTo : null;
document.addEventListener('DOMContentLoaded', () => {
  const origNav = window.navTo;
  window.navTo = function(page) {
    origNav(page);
    if (page === 'prospects') loadProspects();
  };
});
