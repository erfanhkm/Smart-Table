/* Smart Table — Restaurant Portal (v0.6.10)
 * Served from /portal/app.js with a strict Content-Security-Policy
 * (no inline script). The network layer below has no DOM *rendering*
 * dependencies; it uses sessionStorage only for the auth token. */

'use strict';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function money(cents, currency) {
  const cur = currency || 'CAD';
  try {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency: cur }).format((cents || 0) / 100);
  } catch {
    return ((cents || 0) / 100).toFixed(2) + ' ' + cur;
  }
}

const fmtDur = (secs) => {
  if (secs == null) return '—';
  if (secs < 60) return Math.round(secs) + 's';
  return (secs / 60).toFixed(1) + 'm';
};

const timeAgo = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
};

/* ------------------------------------------------------------------ */
/* session (token + identity persist across reloads)                     */
/* ------------------------------------------------------------------ */
const SESSION_KEY = 'st_portal_session';
let token = null;
let portalUser = null; // { email, role, location_id }

function saveSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token, user: portalUser }));
  } catch { /* storage unavailable: session simply won't survive reload */ }
}
function loadSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (s && typeof s.token === 'string' && s.user && typeof s.user.location_id === 'string') return s;
  } catch { /* ignore */ }
  return null;
}
function clearSession() {
  token = null;
  portalUser = null;
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

const CONFIG = {
  API_BASE: '', // same origin
  get locationId() { return portalUser ? portalUser.location_id : null; },
};

/* ------------------------------------------------------------------ */
/* PortalAPI — thin fetch wrapper over the real staff endpoints         */
/* ------------------------------------------------------------------ */
class AuthExpired extends Error {}

async function request(path, options = {}) {
  const { method = 'GET', body, auth = true } = options;
  if (auth && !token) throw new AuthExpired();
  const headers = { 'Content-Type': 'application/json' };
  if (auth && token) headers['Authorization'] = 'Bearer ' + token;
  let res;
  try {
    res = await fetch(CONFIG.API_BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error('Network error — is the server reachable?');
  }
  if (res.status === 401 && auth) {
    handleSessionExpired();
    throw new AuthExpired();
  }
  return res;
}

async function readJson(res) {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { return await res.json(); } catch { return null; }
  }
  return null;
}

const PortalAPI = {
  async getOverview() {
    const res = await request(`/api/dashboard/overview?location_id=${encodeURIComponent(CONFIG.locationId)}`);
    if (!res.ok) throw new Error('Could not load overview.');
    return readJson(res);
  },
  async getMetrics(days) {
    const res = await request(
      `/api/dashboard/metrics?location_id=${encodeURIComponent(CONFIG.locationId)}&days=${encodeURIComponent(days)}`,
    );
    if (!res.ok) throw new Error('Could not load metrics.');
    return readJson(res);
  },
  async exportExcel(days) {
    const res = await request(
      `/api/dashboard/export.xlsx?location_id=${encodeURIComponent(CONFIG.locationId)}&days=${encodeURIComponent(days || 7)}`,
    );
    if (!res.ok) throw new Error('Could not export the report.');
    return res.blob();
  },
  async getTables() {
    const res = await request(`/api/tables?location_id=${encodeURIComponent(CONFIG.locationId)}`);
    if (!res.ok) throw new Error('Could not load tables.');
    const data = await readJson(res);
    return Array.isArray(data) ? data : data.tables || [];
  },
  async createTable(name) {
    const res = await request('/api/tables', {
      method: 'POST',
      body: { location_id: CONFIG.locationId, name },
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error((data && data.error) || 'Could not create table.');
    return data;
  },
  async getCheckDetail(squareOrderId) {
    const res = await request(`/api/checks/${encodeURIComponent(squareOrderId)}`);
    if (!res.ok) throw new Error('Could not load check.');
    return readJson(res);
  },
  /** I-1 aggregate: every open check's detail for this location in ONE
   * request (server fans out to the POS with a cap + a 4s cache). */
  async getOpenChecksDetail() {
    const res = await request(`/api/portal/open-checks-detail?location_id=${encodeURIComponent(CONFIG.locationId)}`);
    if (!res.ok) throw new Error('Could not load open checks.');
    const data = await readJson(res);
    return (data && data.orders) || [];
  },
  async getCheckPayments(checkRef) {
    const res = await request(`/api/portal/checks/${encodeURIComponent(checkRef)}/payments`);
    if (!res.ok) throw new Error('Could not load payments.');
    return readJson(res);
  },
  /** Raw outcome for the idempotent refund flow: { ok, status, error, code, data }. Never throws on HTTP errors. */
  async refundPaymentRaw(paymentId, amountCents, idempotencyKey) {
    const res = await request(`/api/portal/payments/${encodeURIComponent(paymentId)}/refund`, {
      method: 'POST',
      body: { amount_cents: amountCents, idempotency_key: idempotencyKey },
    });
    const data = await readJson(res);
    return { ok: res.ok, status: res.status, error: (data && data.error) || null, code: (data && data.code) || null, data };
  },
  /** Raw outcome for the idempotent cash flow: { ok, status, error, code, data }. Never throws on HTTP errors. */
  async recordCashPaymentRaw(squareOrderId, amountCents, tipCents, idempotencyKey) {
    const res = await request(`/api/checks/${encodeURIComponent(squareOrderId)}/record-external-payment`, {
      method: 'POST',
      body: { mode: 'custom', amount_cents: amountCents, tip_cents: tipCents, idempotency_key: idempotencyKey },
    });
    const data = await readJson(res);
    return { ok: res.ok, status: res.status, error: (data && data.error) || null, code: (data && data.code) || null, data };
  },
  async ackCall(tableId) {
    const res = await request(`/api/tables/${encodeURIComponent(tableId)}/ack-call`, { method: 'POST' });
    if (!res.ok) throw new Error('Could not acknowledge the call.');
    return readJson(res);
  },
  async getServiceAlerts() {
    const res = await request(`/api/service-alerts?location_id=${encodeURIComponent(CONFIG.locationId)}`);
    if (!res.ok) throw new Error('Could not load service alerts.');
    const data = await readJson(res);
    return (data && data.alerts) || [];
  },
  async resolveServiceAlert(id) {
    const res = await request(`/api/service-alerts/${encodeURIComponent(id)}/resolve`, { method: 'POST' });
    if (!res.ok) throw new Error('Could not resolve the alert.');
    return readJson(res);
  },
  async freeTable(tableId) {
    const res = await request(`/api/tables/${encodeURIComponent(tableId)}/free`, { method: 'POST' });
    if (!res.ok) throw new Error('Could not free the table.');
    return readJson(res);
  },
  async linkCheck(tableId, squareOrderId) {
    const res = await request(`/api/tables/${encodeURIComponent(tableId)}/link-check`, {
      method: 'POST',
      body: { square_order_id: squareOrderId },
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error((data && data.error) || 'Could not link the check.');
    return data;
  },
  async getQrBlob(tableId) {
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(CONFIG.API_BASE + `/api/tables/${encodeURIComponent(tableId)}/qr`, { headers });
    if (res.status === 401) { handleSessionExpired(); throw new AuthExpired(); }
    if (!res.ok) throw new Error('Could not load the QR code.');
    return res.blob();
  },
  async getLocations() {
    const res = await request('/api/locations');
    if (!res.ok) throw new Error('Could not load locations.');
    const data = await readJson(res);
    return (data && data.locations) || [];
  },
  async setQrOrdering(locationId, enabled) {
    const res = await request(`/api/locations/${encodeURIComponent(locationId)}`, {
      method: 'PATCH',
      body: { qr_ordering_enabled: !!enabled },
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error((data && data.error) || 'Could not save setting.');
    return data;
  },
  async getOpenOrders() {
    const res = await request(`/api/square-open-orders?location_id=${encodeURIComponent(CONFIG.locationId)}`);
    if (!res.ok) throw new Error('Could not load open orders from Square.');
    const data = await readJson(res);
    return (data && data.orders) || [];
  },
  /** Starts Square OAuth for this user; returns the Square authorize URL to navigate to. */
  async startOAuth() {
    const res = await request('/api/oauth/start', { method: 'POST' });
    const data = await readJson(res);
    if (!res.ok) throw new Error((data && data.error) || 'Could not start Square connect.');
    return data.url;
  },
  async logout() {
    try {
      await request('/api/portal/logout', { method: 'POST' });
    } catch { /* logout is best-effort client-side; the token is dropped regardless */ }
  },
};

/* ------------------------------------------------------------------ */
/* auth                                                                */
/* ------------------------------------------------------------------ */
function showLoginError(msg) {
  const el = $('login-error');
  el.textContent = msg;
  el.style.display = 'block';
}
function clearLoginError() {
  const el = $('login-error');
  el.textContent = '';
  el.style.display = 'none';
}

async function doLogin(email, password) {
  // Login uses a dedicated fetch (not request()): no Authorization header is
  // sent, and 401/429/5xx are mapped to precise messages.
  let res;
  try {
    res = await fetch(CONFIG.API_BASE + '/api/portal/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    showLoginError('Network error — is the server reachable?');
    return;
  }
  if (res.status === 429) {
    const data = await readJson(res);
    showLoginError((data && data.error) || 'Too many attempts — try again in a few minutes.');
    return;
  }
  if (res.status >= 500) {
    showLoginError('Server error — please try again in a moment.');
    return;
  }
  const data = await readJson(res);
  if (!res.ok || !data || !data.token) {
    showLoginError('Invalid email or password.');
    return;
  }
  token = data.token;
  portalUser = { email: data.user.email, role: data.user.role, location_id: data.user.location_id };
  saveSession();
  enterApp();
}

function handleSessionExpired() {
  if (!$('app-shell').classList.contains('on')) return; // already on the login screen
  clearSession();
  resetUi();
  showLogin();
  showLoginError('Session expired. Please sign in again.');
}

async function doLogout() {
  await PortalAPI.logout();
  clearSession();
  resetUi();
  showLogin();
}

/** Clear every trace of the previous restaurant from the UI (shared-tablet safety). */
function resetUi() {
  tablesCache = [];
  drawerTable = null;
  drawerCheckId = null;
  clearCashAttempt();
  const ids = [
    'overview-stats', 'overview-tables', 'recent-activity', 'floor-grid',
    'orders-list', 'order-detail', 'report-cards', 'report-table-body',
    'staff-table-body', 'role-matrix', 'devices-grid', 'billing-content', 'settings-content',
  ];
  for (const id of ids) {
    const el = $(id);
    if (el) el.innerHTML = '';
  }
  closeDrawer();
  closeModal('modal-table');
  closeModal('modal-invite');
  const pw = $('login-password');
  if (pw) pw.value = '';
  setActiveNav('overview');
  currentView = 'overview';
}

function showLogin() {
  $('login-screen').style.display = 'flex';
  $('app-shell').classList.remove('on');
}
function showApp() {
  $('login-screen').style.display = 'none';
  $('app-shell').classList.add('on');
}
function enterApp() {
  clearLoginError();
  $('user-email').textContent = portalUser.email;
  showApp();
  showView('overview');
}

/* ------------------------------------------------------------------ */
/* navigation                                                          */
/* ------------------------------------------------------------------ */
let currentView = 'overview';
const VIEW_TITLES = {
  overview: 'Overview',
  tables: 'Floor & Tables',
  orders: 'Live Orders',
  reports: 'Reports',
  staff: 'Staff',
  devices: 'Devices',
  billing: 'Billing & Subscription',
  settings: 'Settings',
};

function setActiveNav(view) {
  document.querySelectorAll('.nav-item').forEach((b) => {
    const active = b.dataset.view === view;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}

async function showView(view) {
  currentView = view;
  setActiveNav(view);
  $('view-title').textContent = VIEW_TITLES[view] || view;
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const el = $('view-' + view);
  if (el) el.classList.add('active');
  await renderView(view);
}

async function renderView(view) {
  try {
    if (view === 'overview') await renderOverview();
    else if (view === 'tables') await renderTables();
    else if (view === 'orders') await renderLiveOrders();
    else if (view === 'reports') await renderReports();
    else if (view === 'staff') renderStaff();
    else if (view === 'devices') renderDevices();
    else if (view === 'billing') renderBilling();
    else if (view === 'settings') await renderSettings();
  } catch (e) {
    if (e instanceof AuthExpired) return;
    console.error(e);
  }
}

/* ------------------------------------------------------------------ */
/* focus management (drawer + modals)                                  */
/* ------------------------------------------------------------------ */
let lastFocused = null;

function focusables(container) {
  return [...container.querySelectorAll('button, input, select, textarea, a[href]')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
}
function trapTab(container, e) {
  const f = focusables(container);
  if (!f.length) return;
  const first = f[0];
  const last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
function anyOverlayOpen() {
  return $('table-drawer').classList.contains('open') || !!document.querySelector('.modal.show');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($('table-drawer').classList.contains('open')) closeDrawer();
    else {
      const m = document.querySelector('.modal.show');
      if (m) closeModal(m.id);
    }
    return;
  }
  if (e.key === 'Tab') {
    if ($('table-drawer').classList.contains('open')) trapTab($('table-drawer'), e);
    else {
      const m = document.querySelector('.modal.show');
      if (m) trapTab(m, e);
    }
  }
});

function openDrawer() {
  lastFocused = document.activeElement;
  const d = $('table-drawer');
  d.classList.add('open');
  d.removeAttribute('inert');
  const c = $('drawer-close');
  if (c) c.focus();
}
function closeDrawer() {
  const d = $('table-drawer');
  d.classList.remove('open');
  d.setAttribute('inert', '');
  if (lastFocused && typeof lastFocused.focus === 'function') {
    try { lastFocused.focus(); } catch { /* ignore */ }
    lastFocused = null;
  }
}
function openModal(id) {
  lastFocused = document.activeElement;
  const m = $(id);
  m.classList.add('show');
  m.removeAttribute('inert');
  const f = focusables(m)[0];
  if (f) f.focus();
}
function closeModal(id) {
  const m = $(id);
  if (!m) return;
  m.classList.remove('show');
  m.setAttribute('inert', '');
  if (lastFocused && typeof lastFocused.focus === 'function' && !$('table-drawer').classList.contains('open')) {
    try { lastFocused.focus(); } catch { /* ignore */ }
    lastFocused = null;
  }
}

/* ------------------------------------------------------------------ */
/* overview                                                            */
/* ------------------------------------------------------------------ */
let tablesCache = []; // [{ id, name, state, checkId }]

const STATE_LABEL = { FREE: 'Free', SEATED: 'Seated', PAYING: 'Paying', PAID: 'Paid' };

function stateChip(state) {
  const cls = (state || 'FREE').toLowerCase();
  return `<span class="chip ${esc(cls)}">${esc(STATE_LABEL[state] || state || '—')}</span>`;
}

function floorCard(t, showCall) {
  return `<button class="floor-card" data-table-id="${esc(t.id)}" aria-label="${esc(t.name)}, ${esc(STATE_LABEL[t.state] || t.state || '')}${showCall ? ', waiter call active' : ''}">
    <span class="floor-card-head">
      <span class="floor-card-name">${esc(t.name)}</span>
      ${showCall ? '<span class="chip call">Call</span>' : stateChip(t.state)}
    </span>
    <span class="floor-card-body">${t.checkId ? 'Check open' : 'No check'}</span>
  </button>`;
}

async function renderOverview() {
  loadOnboarding().catch(() => { /* wizard is best-effort; the overview must still render */ });
  const oRes = await PortalAPI.getOverview();
  const tables = oRes.tables || [];
  // Populate the drawer cache here too, so overview chips work on first load.
  tablesCache = tables.map((t) => ({ id: t.id, name: t.name, state: t.state, checkId: t.open_order_id || null }));

  const counts = { FREE: 0, SEATED: 0, PAYING: 0, PAID: 0 };
  for (const t of tables) if (counts[t.state] !== undefined) counts[t.state] += 1;

  $('overview-stats').innerHTML = `
    <div class="card"><div class="stat-num">${tables.length}</div><div class="stat-label">Tables</div></div>
    <div class="card"><div class="stat-num">${counts.SEATED + counts.PAYING}</div><div class="stat-label">Occupied</div></div>
    <div class="card"><div class="stat-num">${counts.FREE}</div><div class="stat-label">Free</div></div>
    <div class="card"><div class="stat-num">${(oRes.waiter_calls || []).length}</div><div class="stat-label">Open waiter calls</div></div>`;

  const callIds = new Set((oRes.waiter_calls || []).map((c) => c.table_id));
  $('overview-tables').innerHTML = tables.length
    ? tables.map((t) => floorCard({ id: t.id, name: t.name, state: t.state, checkId: t.open_order_id || null }, callIds.has(t.id))).join('')
    : '<p class="empty">No tables yet — add one from Floor &amp; Tables.</p>';

  renderCalls(oRes.waiter_calls || []);
  renderServiceAlerts().catch(() => { /* alerts are best-effort; the overview must still render */ });
}

/* Service Recovery (idea 1): open alerts sit on top of the overview until a
   staff member resolves them — the guest is still in the building. */
async function renderServiceAlerts() {
  const card = $('service-alerts-card');
  if (!card) return;
  const alerts = await PortalAPI.getServiceAlerts();
  if (!alerts.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  $('service-alerts').innerHTML = alerts.map((a) => `
    <div class="order-row">
      <div class="grow">
        <div class="tname">${a.kind === 'low_rating' ? '🚨' : '🔔'} ${esc(a.table_name || 'Table')}${a.kind === 'low_rating' && a.rating ? ` — ${a.rating}★ rating` : ' — repeated waiter calls'}</div>
        <div class="meta">${a.comment ? esc(a.comment) + ' · ' : ''}${esc(timeAgo(a.created_at))} · go to the table now</div>
      </div>
      <button class="btn btn-sm" data-resolve-alert="${esc(a.id)}">Resolved</button>
    </div>`).join('');
}

/* ------------------------------------------------------------------ */
/* onboarding — "Getting started" wizard on the overview               */
/* State lives server-side (/api/portal/onboarding): POS connection is  */
/* derived from stored POS credentials, the menu step is a live        */
/* verification against the POS catalog, tables from the floor itself. */
/* ------------------------------------------------------------------ */
let onboardingBusy = false;

async function loadOnboarding() {
  const card = $('onboarding-card');
  if (!card) return;
  let s;
  try {
    const res = await request('/api/portal/onboarding');
    s = await readJson(res);
    if (!res.ok) throw new Error('bad status');
  } catch { card.style.display = 'none'; return; }
  if (!s || s.dismissed) { card.style.display = 'none'; return; }
  card.style.display = '';
  const steps = s.steps || {};
  const pos = steps.pos_connected || {};
  const menu = steps.menu_verified || {};
  const tbl = steps.tables_created || {};
  const row = (done, title, desc, actionHtml) => `
    <div style="display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px solid var(--line)">
      <div style="font-size:1.2rem" aria-hidden="true">${done ? '✅' : '⬜'}</div>
      <div style="flex:1">
        <div style="font-weight:600">${title}</div>
        <div style="font-size:.85rem;color:var(--muted)">${desc}</div>
        ${actionHtml || ''}
      </div>
    </div>`;
  const posAction = pos.done ? '' : '<button class="btn btn-sm" id="ob-connect" style="margin-top:8px">Connect POS</button>';
  const menuAction = `
    <button class="btn btn-sm" id="ob-verify" style="margin-top:8px" ${!pos.done || onboardingBusy ? 'disabled' : ''}>${menu.done ? 'Re-verify menu' : 'Verify menu'}</button>
    <div id="ob-menu-result" style="font-size:.85rem;margin-top:6px"></div>`;
  const tblAction = `
    <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">
      <input id="ob-table-count" type="number" min="1" max="50" value="10" aria-label="Number of tables" style="width:70px;padding:6px;border:1px solid var(--line);border-radius:8px">
      <button class="btn btn-sm" id="ob-add-tables" ${onboardingBusy ? 'disabled' : ''}>Add tables</button>
      <button class="btn btn-sm" id="ob-goto-tables">Open Floor &amp; Tables</button>
    </div>`;
  $('onboarding-steps').innerHTML =
    row(pos.done, '1. Connect your POS',
      pos.done ? `Connected (${esc(pos.pos_type || 'POS')}) — Smart Table reads your checks and menu from it.`
               : 'Connect the POS you already use, so checks and menu flow in automatically.', posAction) +
    row(menu.done, '2. Verify your menu',
      menu.done ? `${menu.item_count ?? 0} items found in your POS catalog${menu.verified_at ? ' · verified ' + esc(timeAgo(menu.verified_at)) : ''}. Guests see exactly this menu for QR ordering.`
                : 'We pull your menu straight from your POS catalog — nothing to type in.', menuAction) +
    row(tbl.done, '3. Add your tables',
      tbl.done ? `${tbl.count} table${tbl.count === 1 ? '' : 's'} on your floor. Print each table's QR code from Floor &amp; Tables.`
               : 'Create your tables, then print a QR code for each one.', tblAction) +
    (s.complete ? '<p class="inline-note" style="margin-top:10px">🎉 You\'re live — guests can scan, order and pay. Dismiss this card whenever you\'re ready.</p>' : '');

  const dismiss = $('onboarding-dismiss');
  if (dismiss) dismiss.onclick = async () => {
    try { await request('/api/portal/onboarding/dismiss', { method: 'POST', body: {} }); } catch { /* hide anyway */ }
    card.style.display = 'none';
  };
  const connect = $('ob-connect');
  if (connect) connect.onclick = async () => {
    // Square connects with one click (OAuth); other POS connect in Settings.
    if ((pos.pos_type || 'square') === 'square') {
      connect.disabled = true; connect.textContent = 'Opening…';
      try { window.location.href = await PortalAPI.startOAuth(); }
      catch { connect.disabled = false; connect.textContent = 'Connect POS'; }
    } else {
      showView('settings');
    }
  };
  const verify = $('ob-verify');
  if (verify) verify.onclick = async () => {
    if (onboardingBusy) return;
    onboardingBusy = true;
    const out = $('ob-menu-result');
    if (out) out.textContent = 'Pulling your menu from the POS…';
    try {
      const res = await request('/api/portal/onboarding/verify-menu', { method: 'POST', body: {} });
      const data = await readJson(res);
      if (!res.ok) throw new Error((data && data.error) || 'Menu could not be verified.');
      await loadOnboarding();
      const out2 = $('ob-menu-result');
      if (out2) out2.textContent = `✓ ${data.item_count} items verified just now.`;
    } catch (e) {
      const out3 = $('ob-menu-result');
      if (out3) out3.textContent = e.message || 'Menu could not be verified.';
    } finally { onboardingBusy = false; }
  };
  const add = $('ob-add-tables');
  if (add) add.onclick = async () => {
    if (onboardingBusy) return;
    const n = parseInt((($('ob-table-count') || {}).value || '0'), 10);
    if (!Number.isInteger(n) || n < 1 || n > 50) return;
    onboardingBusy = true;
    try {
      const res = await request('/api/portal/onboarding/quick-tables', { method: 'POST', body: { count: n } });
      const data = await readJson(res);
      if (!res.ok) throw new Error((data && data.error) || 'Could not add tables.');
      await renderOverview();
    } catch { /* wizard stays as-is; the owner can retry */ }
    finally { onboardingBusy = false; }
  };
  const gotoTables = $('ob-goto-tables');
  if (gotoTables) gotoTables.onclick = () => showView('tables');
}

function renderCalls(calls) {
  $('recent-activity').innerHTML = calls.length
    ? calls.map((c) => `
      <div class="order-row">
        <div class="grow">
          <div class="tname"><span class="call-dot" aria-hidden="true"></span>${esc(c.table_name)}<span class="visually-hidden">Active waiter call</span></div>
          <div class="meta">${esc(timeAgo(c.created_at))}</div>
        </div>
        <button class="btn btn-sm" data-ack="${esc(c.table_id)}">Acknowledge</button>
      </div>`).join('')
    : '<p class="empty">No open waiter calls.</p>';
}

/* ------------------------------------------------------------------ */
/* tables                                                              */
/* ------------------------------------------------------------------ */
async function renderTables() {
  const tables = await PortalAPI.getTables();
  tablesCache = tables.map((t) => ({ id: t.id, name: t.name, state: t.state, checkId: t.open_order_id || null }));
  $('floor-grid').innerHTML = tables.length
    ? tables.map((t) => floorCard({ id: t.id, name: t.name, state: t.state, checkId: t.open_order_id || null }, false)).join('')
    : '<p class="empty">No tables yet.</p>';
}

let createTableBusy = false;
async function createTable() {
  if (createTableBusy) return;
  const name = $('table-name').value.trim();
  if (!name) { alert('Enter a table name.'); return; }
  createTableBusy = true;
  const btn = $('btn-create-table');
  btn.disabled = true;
  try {
    await PortalAPI.createTable(name);
    closeModal('modal-table');
    $('table-name').value = '';
    await renderTables();
    if (currentView === 'overview') await renderOverview();
  } catch (e) {
    if (!(e instanceof AuthExpired)) alert(e.message);
  } finally {
    createTableBusy = false;
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* live orders                                                         */
/* ------------------------------------------------------------------ */

/** Concurrency-capped mapper (avoids N+1 stampedes against Square-backed endpoints). */
async function mapCapped(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function getLiveOrders() {
  const oRes = await PortalAPI.getOverview();
  // I-1: prefer the one-request aggregate; fall back to the per-table
  // fan-out only if the aggregate route itself fails.
  try {
    const orders = await PortalAPI.getOpenChecksDetail();
    return { orders, waiter_calls: oRes.waiter_calls || [] };
  } catch { /* fall through to the legacy per-table flow */ }
  const openTables = (oRes.tables || []).filter((t) => t.open_order_id);
  const orders = await mapCapped(openTables, 3, async (t) => {
    try {
      const check = await PortalAPI.getCheckDetail(t.open_order_id);
      return {
        table_id: t.id,
        table_name: t.name,
        id: t.open_order_id,
        total: check.total_cents || 0,
        paid: (check.tenders || []).reduce((s, x) => s + (x.amount_cents || 0), 0),
        remaining: check.remaining_cents || 0,
        currency: check.currency || 'CAD',
        error: false,
      };
    } catch {
      // Carry the failure: the row renders "Unavailable — retry" with cash disabled,
      // instead of a fake "$0.00 remaining" that looks settled.
      return { table_id: t.id, table_name: t.name, id: t.open_order_id, error: true };
    }
  });
  return { orders, waiter_calls: oRes.waiter_calls || [] };
}

function renderLiveOrders() {
  return renderLiveOrdersInner();
}

async function renderLiveOrdersInner() {
  const { orders } = await getLiveOrders();
  const withCheck = orders.filter((o) => !o.error);
  const failed = orders.filter((o) => o.error);
  $('orders-updated').textContent = 'as of ' + new Date().toLocaleTimeString();

  $('orders-list').innerHTML =
    (withCheck.length
      ? withCheck.map((o) => `
      <div class="order-row">
        <div class="grow">
          <div class="tname">${esc(o.table_name)}</div>
          <div class="meta">Order ${(esc((o.id || '').slice(0, 8)))} · ${money(o.remaining, o.currency)} remaining of ${money(o.total, o.currency)}</div>
        </div>
        <button class="btn btn-sm" data-order="${esc(o.table_id)}">View</button>
      </div>`).join('')
      : '<p class="empty">No open checks right now.</p>') +
    (failed.length
      ? failed.map((o) => `
      <div class="order-row">
        <div class="grow">
          <div class="tname">${esc(o.table_name)}</div>
          <div class="meta status-bad">Unavailable — retry</div>
        </div>
        <button class="btn btn-sm" data-retry-orders="1">Retry</button>
      </div>`).join('')
      : '');
}

async function renderOrderDetail(tableId) {
  const box = $('order-detail');
  const t = tablesCache.find((x) => x.id === tableId);
  if (!t || !t.checkId) {
    box.innerHTML = '<p class="empty">No open check on this table.</p>';
    return;
  }
  box.innerHTML = '<p class="empty">Loading…</p>';
  let check;
  try {
    check = await PortalAPI.getCheckDetail(t.checkId);
  } catch (e) {
    if (e instanceof AuthExpired) return;
    box.innerHTML = '<p class="empty">Could not load the check. <button class="btn btn-sm" data-order="' + esc(tableId) + '">Retry</button></p>';
    return;
  }
  const items = check.items || [];
  const tenders = check.tenders || [];
  box.innerHTML = `
    <div style="margin-bottom:10px"><strong>${esc(t.name)}</strong>
      <span class="chip ${esc((check.state || '').toLowerCase())}" style="margin-left:8px">${esc(check.state || '')}</span></div>
    ${items.map((i) => `<div class="bill-line"><span>${esc(i.quantity)}× ${esc(i.name)}</span><span>${money(i.amount_cents, check.currency)}</span></div>`).join('') || '<p class="empty">No items.</p>'}
    ${tenders.map((x) => `<div class="bill-line"><span>Paid (${esc(x.type || 'tender')})</span><span class="neg">−${money(x.amount_cents, check.currency)}</span></div>`).join('')}
    <div class="bill-line total"><span>Remaining</span><span>${money(check.remaining_cents, check.currency)}</span></div>
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-sm btn-primary" data-cash="${esc(t.id)}">Record Cash</button>
      <button class="btn btn-sm" data-freethis="${esc(t.id)}">Free Table</button>
    </div>
    <div id="order-payments"></div>`;
  loadOrderPayments(t.checkId);
}

/* ---- refunds --------------------------------------------------------- */
/* Our own payment rows for this check, each with its refundable          */
/* remainder and a Refund action. Cash rows are listed too — the server   */
/* answers those with a clear "refund at the till" message.               */
async function loadOrderPayments(checkRef) {
  const box = $('order-payments');
  if (!box) return;
  let data;
  try {
    data = await PortalAPI.getCheckPayments(checkRef);
  } catch {
    box.innerHTML = '';
    return;
  }
  const rows = (data.payments || []).filter((p) => p.status === 'AUTHORIZED' || p.status === 'COMPLETED');
  if (!rows.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML =
    '<div style="margin-top:16px"><strong>Payments</strong></div>' +
    rows
      .map((p) => {
        const total = p.amount_cents + p.tip_cents;
        const label = p.payer_label || 'Payment';
        const refunded = p.refunded_cents > 0 ? ` <span class="chip">refunded ${money(p.refunded_cents, p.currency || 'CAD')}</span>` : '';
        const btn =
          p.refundable_cents > 0
            ? `<button class="btn btn-sm" data-refund="${esc(p.id)}" data-max="${p.refundable_cents}" data-cur="${esc(p.currency || 'CAD')}">Refund</button>`
            : '<span class="chip">fully refunded</span>';
        return `<div class="bill-line"><span>${esc(label)} — ${money(total, p.currency || 'CAD')}${refunded}</span><span>${btn}</span></div>`;
      })
      .join('');
  box.querySelectorAll('[data-refund]').forEach((b) =>
    b.addEventListener('click', () => startRefund(b.dataset.refund, Number(b.dataset.max), b.dataset.cur, checkRef)),
  );
}

/* One attempt = one idempotency key per (payment, amount), kept in
   sessionStorage across unknown outcomes (same discipline as cash), so a
   retry can never refund twice. The key is dropped on a confirmed success
   or a confirmed rejection. */
const REFUND_KEY = 'st_portal_refund';
let refundBusy = false;

function loadRefundAttempts() {
  try {
    return JSON.parse(sessionStorage.getItem(REFUND_KEY) || '{}');
  } catch {
    return {};
  }
}
function saveRefundAttempts(a) {
  try {
    sessionStorage.setItem(REFUND_KEY, JSON.stringify(a));
  } catch { /* ignore */ }
}
function newRefundKey() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'k-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

async function startRefund(paymentId, maxCents, currency, checkRef) {
  if (refundBusy) return;
  const raw = prompt(
    `Refund amount — up to ${money(maxCents, currency)}. Leave unchanged for the full remaining amount:`,
    (maxCents / 100).toFixed(2),
  );
  if (raw === null) return;
  const cents = Math.round(parseFloat(String(raw).replace(',', '.')) * 100);
  if (!Number.isFinite(cents) || cents <= 0 || cents > maxCents) {
    alert('Enter a valid amount up to the refundable remainder.');
    return;
  }
  if (!confirm(`Refund ${money(cents, currency)} to the guest's card?`)) return;
  refundBusy = true;
  try {
    const attempts = loadRefundAttempts();
    const sig = `${paymentId}|${cents}`;
    if (!attempts[sig]) {
      attempts[sig] = newRefundKey();
      saveRefundAttempts(attempts);
    }
    const out = await PortalAPI.refundPaymentRaw(paymentId, cents, attempts[sig]);
    if (out.ok) {
      delete attempts[sig];
      saveRefundAttempts(attempts);
      alert('Refund sent to the guest\u2019s card.');
    } else if (out.status === 409) {
      // Unknown outcome — keep the key so a retry replays the same refund.
      alert(out.error || 'This refund is still being confirmed. Check again in a moment before retrying.');
    } else {
      delete attempts[sig];
      saveRefundAttempts(attempts);
      alert(out.error || 'Refund failed.');
    }
  } catch {
    alert('Network problem — the refund may or may not have gone through. Check the payment before retrying.');
  } finally {
    refundBusy = false;
    const t = tablesCache.find((x) => x.checkId === checkRef);
    if (t) renderOrderDetail(t.id);
  }
}

/* ---- idempotent cash recording -------------------------------------- */
/* One attempt = one key per (order, amount). The key is kept on any     */
/* unknown outcome (network error / 5xx / unknown 409), so retrying      */
/* replays the SAME request and can never record the cash twice; it is   */
/* dropped only after a confirmed success or a confirmed rejection.      */
const CASH_KEY = 'st_portal_cash';
let cashBusy = false;
let memCash = null;

function loadCashAttempt() {
  if (memCash) return memCash;
  try { memCash = JSON.parse(sessionStorage.getItem(CASH_KEY) || 'null'); } catch { memCash = null; }
  return memCash;
}
function saveCashAttempt(a) {
  memCash = a;
  try { sessionStorage.setItem(CASH_KEY, JSON.stringify(a)); } catch { /* ignore */ }
}
function clearCashAttempt() {
  memCash = null;
  try { sessionStorage.removeItem(CASH_KEY); } catch { /* ignore */ }
}

/** Strict amount: digits with optional 1-2 decimals; comma accepted as the decimal separator. */
function parseCashAmount(raw) {
  const s = String(raw || '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const v = parseFloat(s);
  return v > 0 ? v : null;
}

async function recordCashPayment() {
  if (cashBusy) return;
  const amt = parseCashAmount($('cash-amount').value);
  if (amt === null) { alert('Enter a valid amount like 12.50.'); return; }
  const cents = Math.round(amt * 100);
  if (!drawerCheckId || !drawerTable) return;

  cashBusy = true;
  const btn = $('btn-record-cash');
  if (btn) btn.disabled = true;
  try {
    const bill = await PortalAPI.getCheckDetail(drawerCheckId).catch(() => null);
    if (!bill) { alert('Could not load the check. Please retry.'); return; }

    const sig = `${drawerCheckId}|${cents}`;
    let attempt = loadCashAttempt();
    if (!attempt || attempt.sig !== sig) {
      // Fresh attempt: validate against the live balance and confirm with the human.
      if (cents > bill.remaining_cents) {
        alert(`That is more than the remaining balance (${money(bill.remaining_cents, bill.currency)}).`);
        return;
      }
      // E-6: tender-blind POS (Shopify/Helcim) can't record a partial
      // external payment — recording one completes the POS check in
      // full. Staff must see that before confirming, not discover it.
      const posClosureNote = (bill.pos_type === 'shopify' || bill.pos_type === 'helcim')
        ? `\nNote: on ${bill.pos_type === 'shopify' ? 'Shopify' : 'Helcim'}, recording a payment marks the ENTIRE check as paid in the POS, regardless of the amount entered.`
        : '';
      if (!confirm(
        `Record ${money(cents, bill.currency)} cash for ${drawerTable.name}?\n` +
        `Check total: ${money(bill.total_cents, bill.currency)}\n` +
        `Remaining after: ${money(bill.remaining_cents - cents, bill.currency)}` +
        posClosureNote,
      )) return;
      attempt = { sig, key: crypto.randomUUID() };
      saveCashAttempt(attempt);
    }

    const res = await PortalAPI.recordCashPaymentRaw(drawerCheckId, cents, 0, attempt.key);
    if (res.ok) {
      clearCashAttempt();
      alert('Cash payment recorded.');
      closeDrawer();
      await renderView(currentView);
      return;
    }
    if (res.status === 400 || res.status === 402 ||
        (res.status === 409 && (res.code === 'payment_failed' || res.code === 'payment_cancelled'))) {
      clearCashAttempt(); // confirmed: nothing was recorded
      alert(res.error || 'Payment rejected.');
      return;
    }
    alert(`${res.error || 'The result is not confirmed.'}\n\nCheck the bill, then try again — the same request is re-sent and cannot be recorded twice.`);
  } catch (e) {
    if (!(e instanceof AuthExpired)) {
      alert('Network problem — the result is not confirmed. Try again: the same request is re-sent and cannot be recorded twice.');
    }
  } finally {
    cashBusy = false;
    if (btn) btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* table drawer                                                        */
/* ------------------------------------------------------------------ */
let drawerSeq = 0;
let drawerTable = null;
let drawerCheckId = null;

async function openTableDrawer(tableId) {
  const seq = ++drawerSeq;
  const table = tablesCache.find((t) => t.id === tableId);
  if (!table) return;
  drawerTable = table;
  drawerCheckId = table.checkId;

  $('drawer-title').textContent = table.name;
  $('drawer-body').innerHTML = '<p class="empty">Loading…</p>';
  $('drawer-footer').innerHTML = '';
  openDrawer();

  let detail = null;
  if (table.checkId) {
    try {
      detail = await PortalAPI.getCheckDetail(table.checkId);
    } catch (e) {
      if (e instanceof AuthExpired) return;
      if (seq !== drawerSeq) return;
      // Error path: show the failure with a retry, keep QR + Free available.
      $('drawer-body').innerHTML =
        '<div class="inline-note" style="border-color:#fca5a5;background:#fef2f2;color:#991b1b">' +
        'Could not load the check. The table may still have an open check.</div>' +
        '<div style="margin-top:12px"><button class="btn btn-sm btn-primary" id="drawer-retry">Retry</button></div>';
      $('drawer-footer').innerHTML = `
        <button class="btn btn-sm" id="drawer-qr">Print QR</button>
        <button class="btn btn-sm btn-danger" id="drawer-free">Free Table</button>`;
      $('drawer-retry').addEventListener('click', () => openTableDrawer(tableId));
      wireDrawerFooter(table);
      return;
    }
  }
  if (seq !== drawerSeq) return;

  if (!detail) {
    $('drawer-body').innerHTML = '<p class="empty">No open check on this table.</p>' +
      '<div style="margin-top:12px"><button class="btn btn-sm btn-primary" id="drawer-link">Link Check</button></div>';
    $('drawer-link').addEventListener('click', () => showLinkCheck(table));
  } else {
    const items = detail.items || [];
    const tenders = detail.tenders || [];
    $('drawer-body').innerHTML = `
      <div class="bill-line total" style="border:0;margin:0;padding-top:0"><span>Check total</span><span>${money(detail.total_cents, detail.currency)}</span></div>
      ${items.map((i) => `<div class="bill-line"><span>${esc(i.quantity)}× ${esc(i.name)}</span><span>${money(i.amount_cents, detail.currency)}</span></div>`).join('')}
      ${tenders.map((x) => `<div class="bill-line"><span>Paid (${esc(x.type || 'tender')})</span><span class="neg">−${money(x.amount_cents, detail.currency)}</span></div>`).join('')}
      <div class="bill-line total"><span>Remaining</span><span>${money(detail.remaining_cents, detail.currency)}</span></div>
      <div class="cash-box">
        <label for="cash-amount">Record cash payment</label>
        <div class="cash-row">
          <input id="cash-amount" inputmode="decimal" placeholder="0.00" autocomplete="off">
          <button class="btn btn-primary" id="btn-record-cash">Record</button>
        </div>
      </div>
      <div style="margin-top:12px"><button class="btn btn-sm" id="drawer-link">Link a different check</button></div>`;
    $('btn-record-cash').addEventListener('click', recordCashPayment);
    $('drawer-link').addEventListener('click', () => showLinkCheck(table));
  }

  $('drawer-footer').innerHTML = `
    <button class="btn btn-sm" id="drawer-qr">Print QR</button>
    <button class="btn btn-sm btn-danger" id="drawer-free">Free Table</button>`;
  wireDrawerFooter(table);
}

function wireDrawerFooter(table) {
  const q = $('drawer-qr');
  if (q) q.addEventListener('click', () => printQr(table.id, table.name));
  const f = $('drawer-free');
  if (f) f.addEventListener('click', () => confirmFreeTable(table));
}

let linkBusy = false;
async function showLinkCheck(table) {
  let orders;
  try {
    orders = await PortalAPI.getOpenOrders();
  } catch (e) {
    if (!(e instanceof AuthExpired)) alert(e.message);
    return;
  }
  if (!orders.length) { alert('No open orders in Square right now.'); return; }
  $('drawer-body').innerHTML = `
    <h4 style="margin-bottom:10px">Link a Square check to ${esc(table.name)}</h4>
    <label class="f-label" for="link-order">Open order</label>
    <select class="form-control" id="link-order">
      <option value="">Select an order…</option>
      ${orders.map((o) => `<option value="${esc(o.id)}">${esc(money(o.total_money && o.total_money.amount, o.total_money && o.total_money.currency))} — ${esc(o.items || (o.id || '').slice(0, 8))}</option>`).join('')}
    </select>
    <div class="modal-actions" style="justify-content:flex-start">
      <button class="btn btn-primary" id="btn-do-link">Link Check</button>
    </div>`;
  $('drawer-footer').innerHTML = '';
  $('btn-do-link').addEventListener('click', async () => {
    if (linkBusy) return;
    const orderId = $('link-order').value;
    if (!orderId) { alert('Select an order first.'); return; }
    linkBusy = true;
    const btn = $('btn-do-link');
    btn.disabled = true;
    try {
      await PortalAPI.linkCheck(table.id, orderId);
      closeDrawer();
      await renderView(currentView);
      if (currentView !== 'overview') await renderOverview();
    } catch (e) {
      if (!(e instanceof AuthExpired)) alert(e.message);
    } finally {
      linkBusy = false;
      btn.disabled = false;
    }
  });
}

async function confirmFreeTable(table) {
  if (!confirm(`Free ${table.name}?\n\nThe table will be marked free. Any open check is left untouched in Square.`)) return;
  try {
    await PortalAPI.freeTable(table.id);
    closeDrawer();
    await renderView(currentView);
    if (currentView !== 'overview') await renderOverview();
  } catch (e) {
    if (!(e instanceof AuthExpired)) alert(e.message);
  }
}

/** Print the table's QR. The window opens synchronously in the click handler
 * (popup blockers kill async opens); printing waits for the image to load. */
async function printQr(tableId, tableName) {
  const win = window.open('', '_blank');
  if (!win) { alert('Please allow popups to print the QR code.'); return; }
  let blob;
  try {
    blob = await PortalAPI.getQrBlob(tableId);
  } catch (e) {
    win.close();
    if (!(e instanceof AuthExpired)) alert(e.message);
    return;
  }
  const url = URL.createObjectURL(blob);
  win.document.write(
    '<html><head><title>QR — ' + esc(tableName) + '</title></head>' +
    '<body style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif">' +
    '<h2>' + esc(tableName) + '</h2>' +
    '<p>Scan to view your bill &amp; pay</p>' +
    '<img id="qrimg" src="' + url + '" style="width:320px;height:320px">' +
    '</body></html>',
  );
  win.document.close();
  const doPrint = () => { win.focus(); win.print(); };
  const img = win.document.getElementById('qrimg');
  if (img && img.complete) doPrint();
  else if (img) img.onload = doPrint;
  else win.onload = doPrint;
}

/* ------------------------------------------------------------------ */
/* reports                                                             */
/* ------------------------------------------------------------------ */
let reportSeq = 0;

function rangeLabel(days) {
  return days === 1 ? 'Last 24 hours' : `Last ${days} days`;
}

async function renderReports() {
  const seq = ++reportSeq;
  const days = parseInt($('report-range').value, 10) || 7;
  let met;
  try {
    met = await PortalAPI.getMetrics(days);
  } catch (e) {
    if (e instanceof AuthExpired) return;
    $('report-cards').innerHTML = '<div class="card"><p class="empty">Could not load metrics.</p></div>';
    return;
  }
  if (seq !== reportSeq) return;
  const label = rangeLabel(met.window_days || days);
  $('report-cards').innerHTML = `
    <div class="card"><div class="stat-num">${fmtDur(met.avg_settlement_secs)}</div><div class="stat-label">Avg settlement time · ${esc(label)}</div></div>
    <div class="card"><div class="stat-num">${met.settled_checks ?? '—'}</div><div class="stat-label">Settled checks · ${esc(label)}</div></div>
    <div class="card"><div class="stat-num">${fmtDur(met.avg_waiter_response_secs)}</div><div class="stat-label">Avg waiter response · ${esc(label)}</div></div>
    <div class="card"><div class="stat-num">${met.open_calls ?? '—'}</div><div class="stat-label">Open waiter calls</div></div>`;

  // Daily breakdown: real data from the metrics API (payments minus refunds).
  const daily = Array.isArray(met.daily) ? met.daily : [];
  $('report-table-body').innerHTML = daily.length
    ? daily.map((r) =>
        `<tr><td>${esc(new Date(`${r.date}T12:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }))}</td><td>${r.checks}</td><td>${money(r.revenue_cents, 'CAD')}</td><td>${money(r.avg_tip_cents, 'CAD')}</td></tr>`,
      ).join('')
    : '<tr><td colspan="4">No settled payments in this range yet.</td></tr>';

  // Revenue by table (idea 5): floor heatmap + ranking. Intensity scales to
  // the best table of the range; zero-revenue tables stay pale.
  const tbl = Array.isArray(met.tables) ? met.tables : [];
  const maxRev = Math.max(0, ...tbl.map((x) => x.revenue_cents));
  $('report-table-heat').innerHTML = tbl.length
    ? tbl.map((x) => {
        const heat = maxRev > 0 ? Math.max(0, x.revenue_cents) / maxRev : 0;
        const bg = heat > 0 ? `background:rgba(217,119,6,${(0.12 + heat * 0.55).toFixed(2)});` : '';
        const top = maxRev > 0 && x.revenue_cents === maxRev && x.revenue_cents > 0;
        return `<div class="floor-card" style="${bg}">
          <span class="floor-card-head"><span class="floor-card-name">${esc(x.table_name)}${top ? ' ⭐' : ''}</span></span>
          <span class="floor-card-body">${money(x.revenue_cents, 'CAD')} · ${x.checks} check${x.checks === 1 ? '' : 's'}</span>
        </div>`;
      }).join('')
    : '<p class="empty">No tables yet.</p>';
  $('report-tables-body').innerHTML = tbl.length
    ? tbl.map((x) =>
        `<tr><td>${esc(x.table_name)}</td><td>${money(x.revenue_cents, 'CAD')}</td><td>${x.checks}</td><td>${money(x.avg_bill_cents, 'CAD')}</td><td>${money(x.tips_cents, 'CAD')}</td><td>${x.share_pct}%</td></tr>`,
      ).join('')
    : '<tr><td colspan="6">No tables yet.</td></tr>';
}

/* ------------------------------------------------------------------ */
/* staff (demo)                                                        */
/* ------------------------------------------------------------------ */
function renderStaff() {
  const staff = [
    { name: 'Sarah Chen', role: 'Manager', status: 'Active' },
    { name: 'Marcus Webb', role: 'Waiter', status: 'Active' },
    { name: 'Priya Sharma', role: 'Waiter', status: 'Off shift' },
  ];
  $('staff-table-body').innerHTML = staff.map((s) => `
    <tr><td>${esc(s.name)}</td><td>${esc(s.role)}</td>
    <td><span class="chip ${s.status === 'Active' ? 'seated' : 'paid'}">${esc(s.status)}</span></td>
    <td></td></tr>`).join('');

  const matrix = [
    ['View tables', true, true, true],
    ['Free tables', true, true, false],
    ['Record cash', true, true, false],
    ['View reports', true, true, false],
    ['Manage staff', true, false, false],
  ];
  const mark = (v) => (v ? '<span class="status-ok">✓ Yes</span>' : '<span class="status-bad">✗ No</span>');
  $('role-matrix').innerHTML = matrix.map((r) =>
    `<tr><td>${esc(r[0])}</td><td>${mark(r[1])}</td><td>${mark(r[2])}</td><td>${mark(r[3])}</td></tr>`,
  ).join('');
}

/* ------------------------------------------------------------------ */
/* devices (demo)                                                      */
/* ------------------------------------------------------------------ */
function renderDevices() {
  const devices = [
    { table: 'Table 1', battery: 87, led: 'Green' },
    { table: 'Table 2', battery: 64, led: 'Blue' },
    { table: 'Table 3', battery: 23, led: 'Yellow' },
    { table: 'Table 4', battery: 91, led: 'Green' },
  ];
  $('devices-grid').innerHTML = devices.map((d) => `
    <div class="card">
      <h4>${esc(d.table)}</h4>
      <div class="kv"><span class="k">Battery</span><span class="${d.battery < 30 ? 'status-bad' : 'status-ok'}">${d.battery}%${d.battery < 30 ? ' — charge soon' : ''}</span></div>
      <div class="kv"><span class="k">LED</span><span>${esc(d.led)}</span></div>
      <div class="kv"><span class="k">Status</span><span class="status-ok">Online</span></div>
    </div>`).join('');
}

/* ------------------------------------------------------------------ */
/* billing (v0.4 — real billing)                                       */
/* Two ways to pay for Smart Table:                                    */
/*  - Commission: 2% of each guest card payment (Square takes it as an */
/*    application fee at charge time; other POS accrue monthly).       */
/*  - Subscription: flat monthly price via Square Subscriptions,       */
/*    charged to the card on file. No per-payment fees.                */
/* ------------------------------------------------------------------ */
let billingCardInstance = null;
let billingBusy = false;

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the card form.'));
    document.head.appendChild(s);
  });
}

async function renderBilling() {
  const box = $('billing-content');
  box.innerHTML = '<div class="card"><p class="empty">Loading…</p></div>';
  let st;
  let entries = [];
  try {
    const res = await request('/api/portal/billing');
    const data = await readJson(res);
    if (!res.ok) throw new Error((data && data.error) || 'Could not load billing.');
    st = data;
    const hres = await request('/api/portal/billing/history');
    if (hres.ok) entries = (await readJson(hres)).entries || [];
  } catch (e) {
    if (e instanceof AuthExpired) return;
    box.innerHTML = `<div class="card"><p class="empty">${esc(e.message || 'Could not load billing.')}</p></div>`;
    return;
  }

  const cur = st.currency;
  const isCommission = st.effective_plan === 'commission';
  const price = money(st.subscription_price_cents, cur);
  const pendingNote = st.pending_plan === 'commission' && st.subscription_paid_through
    ? `<p class="stat-label" style="margin-top:8px">Switching to Commission after ${esc(st.subscription_paid_through)} — your subscription is paid through then, so you never pay twice for the same days.</p>`
    : '';
  const subStatus = st.plan === 'subscription'
    ? `<div class="stat-label">Status: ${esc(st.subscription_status || '—')}${st.subscription_paid_through ? ` · paid through ${esc(st.subscription_paid_through)}` : ''}</div>`
    : '';

  box.innerHTML = `
    <div class="grid grid-2" style="margin-bottom:16px">
      <div class="card" style="${isCommission ? 'outline:2px solid var(--accent)' : ''}">
        <h4>Commission ${isCommission ? '· Current plan' : ''}</h4>
        <div class="stat-num" style="font-size:1.4rem">${st.commission_percent}% per payment</div>
        <div class="stat-label">Taken only when a guest pays by card through Smart Table. No monthly fee, nothing when you're closed.</div>
        ${pendingNote}
        <div style="margin-top:12px">
          <button class="btn" id="billing-plan-commission" ${isCommission && !st.pending_plan ? 'disabled' : ''}>${isCommission ? 'Current plan' : 'Switch to Commission'}</button>
        </div>
      </div>
      <div class="card" style="${!isCommission ? 'outline:2px solid var(--accent)' : ''}">
        <h4>Base — Subscription ${!isCommission ? '· Current plan' : ''}</h4>
        <div class="stat-num" style="font-size:1.4rem">${price}/month</div>
        <div class="stat-label">Flat monthly fee charged to your card on file. No per-payment fees, ever.</div>
        ${subStatus}
        <div style="margin-top:12px">
          <button class="btn" id="billing-plan-subscription" ${!isCommission ? 'disabled' : ''}>${!isCommission ? 'Current plan' : 'Switch to Base'}</button>
        </div>
      </div>
    </div>
    <div class="grid grid-2" style="margin-bottom:16px">
      <div class="card">
        <h4>Payment Method</h4>
        ${st.has_card
          ? `<div class="stat-num" style="font-size:1.15rem">${esc(st.card_brand || 'Card')} •••• ${esc(st.card_last4 || '')}</div>
             <div class="stat-label">Used for the subscription plan and monthly fee collection.</div>`
          : `<div class="stat-label">No card on file. Add one to use the Base plan.</div>`}
        <div id="billing-card-form-wrap" style="margin-top:12px">
          <button class="btn" id="billing-card-toggle">${st.has_card ? 'Update card' : 'Add card'}</button>
          <div id="billing-card-form" style="display:none;margin-top:12px">
            <div id="billing-sq-card" style="min-height:96px"></div>
            <p class="stat-label" id="billing-card-msg" role="alert"></p>
            <button class="btn" id="billing-card-save" style="margin-top:8px">Save card</button>
          </div>
        </div>
      </div>
      <div class="card">
        <h4>This Month</h4>
        <div class="kv"><span class="k">Fees collected</span><span>${money(st.collected_this_month_cents, cur)}</span></div>
        <div class="kv"><span class="k">Fees accrued (unbilled)</span><span>${money(st.accrued_cents, cur)}</span></div>
        <div class="kv"><span class="k">Plan</span><span>${isCommission ? 'Commission' : 'Base — Subscription'}</span></div>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px;opacity:.85">
      <h4>Pro — ${money(19900, cur)}/month <span class="chip" style="margin-left:8px">Coming soon</span></h4>
      <div class="stat-label">For larger rooms and groups: multiple locations under one account, advanced analytics, your own branding on the guest page, loyalty, device health monitoring with priority replacement, and priority support. Pro is on its way — no action needed today.</div>
    </div>
    <div class="card">
      <h4>Billing History</h4>
      <table class="data-table">
        <thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Status</th></tr></thead>
        <tbody>
          ${entries.map((en) => `<tr>
            <td>${esc(new Date(en.date).toLocaleDateString('en-CA'))}</td>
            <td>${esc(en.description)}</td>
            <td>${money(en.amount_cents, en.currency)}</td>
            <td>${esc(en.status)}</td>
          </tr>`).join('') || '<tr><td colspan="4">No billing activity yet.</td></tr>'}
        </tbody>
      </table>
    </div>`;

  const commBtn = $('billing-plan-commission');
  if (commBtn) commBtn.addEventListener('click', () => switchBillingPlan('commission', st));
  const subBtn = $('billing-plan-subscription');
  if (subBtn) subBtn.addEventListener('click', () => switchBillingPlan('subscription', st));
  const toggle = $('billing-card-toggle');
  if (toggle) toggle.addEventListener('click', initBillingCardForm);
}

async function switchBillingPlan(plan, st) {
  if (billingBusy) return;
  if (plan === 'subscription') {
    if (!st.has_card) { alert('Add a payment card first, then switch to the Base plan.'); return; }
    if (!confirm(`Switch to the Base plan? Your card will be charged ${money(st.subscription_price_cents, st.currency)} today and monthly. Per-payment fees stop immediately.`)) return;
  } else if (st.plan === 'subscription' && !confirm('Switch to the Commission plan? Your subscription stays active until the end of the paid period; the per-payment fee starts after that.')) {
    return;
  }
  billingBusy = true;
  try {
    const res = await request('/api/portal/billing/plan', { method: 'POST', body: { plan } });
    const data = await readJson(res);
    if (!res.ok) throw new Error((data && data.error) || 'Could not switch plans.');
    await renderBilling();
  } catch (e) {
    if (e instanceof AuthExpired) return;
    alert(e.message || 'Could not switch plans.');
  } finally {
    billingBusy = false;
  }
}

async function initBillingCardForm() {
  const form = $('billing-card-form');
  if (!form) return;
  if (form.style.display !== 'none') { form.style.display = 'none'; return; }
  form.style.display = 'block';
  if (billingCardInstance) return;
  const msg = $('billing-card-msg');
  try {
    const res = await request('/api/portal/billing/card-config');
    const cfg = await readJson(res);
    if (!res.ok || !cfg) throw new Error('Could not load the card form.');
    const env = cfg.extra.environment === 'sandbox' ? 'sandbox.' : '';
    await loadScriptOnce(`https://${env}web.squarecdn.com/v1/square.js`);
    if (!window.Square) throw new Error('Could not load the secure card form — check your connection and try again.');
    const payments = window.Square.payments(cfg.publishableKey, cfg.extra.locationId);
    billingCardInstance = await payments.card();
    await billingCardInstance.attach('#billing-sq-card');
    $('billing-card-save').addEventListener('click', saveBillingCard);
  } catch (e) {
    if (msg) msg.textContent = e.message || 'Could not load the card form.';
  }
}

async function saveBillingCard() {
  if (!billingCardInstance || billingBusy) return;
  const msg = $('billing-card-msg');
  billingBusy = true;
  try {
    const result = await billingCardInstance.tokenize({
      intent: 'STORE',
      customerInitiated: true,
      sellerKeyedIn: false,
    });
    if (result.status !== 'OK') {
      const detail = (result.errors && result.errors[0] && result.errors[0].message) || 'Please check the card details.';
      throw new Error(detail);
    }
    const res = await request('/api/portal/billing/card', {
      method: 'POST',
      body: { source_id: result.token, verification_token: result.verificationToken || undefined },
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error((data && data.error) || 'Could not save the card.');
    billingCardInstance = null;
    await renderBilling();
  } catch (e) {
    if (e instanceof AuthExpired) return;
    if (msg) msg.textContent = e.message || 'Could not save the card.';
  } finally {
    billingBusy = false;
  }
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */
async function renderSettings() {
  const box = $('settings-content');
  box.innerHTML = '<div class="card"><p class="empty">Loading…</p></div>';

  let locations = [];
  let sq = { connected: null, note: '' };
  try {
    locations = await PortalAPI.getLocations();
  } catch (e) {
    if (e instanceof AuthExpired) return;
    // locations failed: profile stays empty-disabled, Square shows the error state below
  }
  try {
    sq = await getSquareStatus(locations);
  } catch {
    sq = { connected: null, note: "Couldn't check Square status." };
  }

  const locName = locations.length ? locations[0].name || '' : '';
  const sqBadge = sq.isDemo ? '<div class="badge-row"><span class="demo-badge">Demo Data</span></div>' : '';

  box.innerHTML = `
    <div class="card">
      <div class="badge-row"><h4 style="margin:0">Restaurant Profile</h4><span class="demo-badge soon">Not saved yet — editing disabled</span></div>
      <label class="f-label" for="profile-name">Restaurant name</label>
      <input class="form-control" id="profile-name" value="${esc(locName)}" readonly disabled>
      <label class="f-label" for="profile-email">Contact email</label>
      <input class="form-control" id="profile-email" value="" placeholder="—" disabled>
      <label class="f-label" for="profile-phone">Phone</label>
      <input class="form-control" id="profile-phone" value="" placeholder="—" disabled>
      <div style="margin-top:6px"><button class="btn btn-primary" disabled title="Profile saving isn't wired up yet">Save Changes</button></div>
    </div>
    <div class="card">
      ${sqBadge}
      <h4>Square Connection</h4>
      <div class="kv"><span class="k">Status</span><span class="${sq.connected ? 'status-ok' : sq.connected === false ? 'status-bad' : 'status-warn'}">${esc(sq.label)}</span></div>
      <div class="kv"><span class="k">Location</span><span>${esc(sq.locationName || '—')}</span></div>
      ${sq.note ? `<div class="inline-note">${esc(sq.note)}</div>` : ''}
      <div style="margin-top:12px"><button class="btn" id="btn-reconnect">Reconnect Square</button></div>
    </div>
    <div class="card">
      <h4>QR Ordering</h4>
      <p class="inline-note">When enabled, guests who scan the table QR can browse your menu and send orders straight to your ${esc(sq.locationName ? 'POS' : 'POS')}. The order appears in your POS with the table name attached.</p>
      <div class="kv"><span class="k">Status</span>
        <label class="switch"><input type="checkbox" id="qr-ordering-toggle" ${locations[0]?.qr_ordering_enabled ? 'checked' : ''} ${locations.length ? '' : 'disabled'}>
        <span class="slider"></span></label>
      </div>
      <div class="inline-note" id="qr-ordering-note"></div>
    </div>`;

  $('btn-reconnect').addEventListener('click', async () => {
    const btn = $('btn-reconnect');
    btn.disabled = true;
    try {
      const url = await PortalAPI.startOAuth();
      window.location.href = url;
    } catch (e) {
      if (!(e instanceof AuthExpired)) alert(e.message);
      btn.disabled = false;
    }
  });

  const qrToggle = $('qr-ordering-toggle');
  if (qrToggle && locations.length) {
    qrToggle.addEventListener('change', async () => {
      const note = $('qr-ordering-note');
      qrToggle.disabled = true;
      try {
        await PortalAPI.setQrOrdering(locations[0].id, qrToggle.checked);
        note.textContent = qrToggle.checked ? 'QR ordering is ON — guests will see the Menu tab.' : 'QR ordering is OFF.';
        note.style.color = 'var(--green)';
      } catch (e) {
        if (!(e instanceof AuthExpired)) {
          note.textContent = 'Could not save: ' + e.message;
          note.style.color = 'var(--red)';
          qrToggle.checked = !qrToggle.checked;
        }
      } finally {
        qrToggle.disabled = false;
      }
    });
  }

  // Loyalty + Google review URL (v0.2)
  const loc0 = locations[0];
  if (loc0) {
    const loyCard = document.createElement('div');
    loyCard.className = 'card';
    loyCard.innerHTML = `
      <h4>Loyalty Program</h4>
      <p class="inline-note">Guests join with just their phone number — no account. After N visits they earn your reward.</p>
      <div class="kv"><span class="k">Enabled</span>
        <label class="switch"><input type="checkbox" id="loyalty-toggle" ${loc0.loyalty_enabled ? 'checked' : ''}>
        <span class="slider"></span></label>
      </div>
      <div class="kv"><span class="k">Visits for reward</span>
        <input class="form-control" id="loyalty-visits" type="number" min="2" max="50" value="${esc(String(loc0.loyalty_visits_required ?? 5))}" style="width:80px;">
      </div>
      <div class="kv"><span class="k">Reward</span>
        <input class="form-control" id="loyalty-reward" type="text" maxlength="100" value="${esc(loc0.loyalty_reward_text ?? 'Free dessert')}" style="width:200px;">
      </div>
      <div style="margin-top:8px"><button class="btn btn-primary" id="loyalty-save">Save Loyalty</button></div>
      <div class="inline-note" id="loyalty-note"></div>
      <h4 style="margin-top:16px;">Google Review Link</h4>
      <p class="inline-note">Guests who rate 4-5 stars get this link. Find it in your Google Business profile → Share review form.</p>
      <input class="form-control" id="review-url" type="url" placeholder="https://g.page/..." value="${esc(loc0.google_review_url ?? '')}" style="width:100%;">
      <div style="margin-top:8px"><button class="btn btn-primary" id="review-save">Save Review Link</button></div>
      <div class="inline-note" id="review-note"></div>
      <h4 style="margin-top:16px;">Recent Guest Feedback</h4>
      <div id="feedback-list"><p class="inline-note">Loading…</p></div>`;
    box.appendChild(loyCard);

    $('loyalty-save').addEventListener('click', async () => {
      const note = $('loyalty-note');
      try {
        const res = await request(`/api/locations/${encodeURIComponent(loc0.id)}`, {
          method: 'PATCH',
          body: {
            loyalty_enabled: $('loyalty-toggle').checked,
            loyalty_visits_required: Number($('loyalty-visits').value),
            loyalty_reward_text: $('loyalty-reward').value,
          },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not save.');
        note.textContent = 'Saved ✓'; note.style.color = 'var(--green)';
      } catch (e) {
        if (!(e instanceof AuthExpired)) { note.textContent = 'Could not save: ' + e.message; note.style.color = 'var(--red)'; }
      }
    });
    $('review-save').addEventListener('click', async () => {
      const note = $('review-note');
      try {
        const res = await request(`/api/locations/${encodeURIComponent(loc0.id)}`, {
          method: 'PATCH',
          body: { google_review_url: $('review-url').value },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not save.');
        note.textContent = 'Saved ✓'; note.style.color = 'var(--green)';
      } catch (e) {
        if (!(e instanceof AuthExpired)) { note.textContent = 'Could not save: ' + e.message; note.style.color = 'var(--red)'; }
      }
    });

    // Load recent feedback
    try {
      const res = await request(`/api/feedback?location_id=${encodeURIComponent(loc0.id)}`);
      const data = await res.json().catch(() => ({}));
      const list = $('feedback-list');
      const fb = (data && data.feedback) || [];
      if (!fb.length) {
        list.innerHTML = '<p class="inline-note">No feedback yet.</p>';
      } else {
        list.innerHTML = fb.map((f) => `
          <div class="kv"><span>${'⭐'.repeat(f.rating)}${f.comment ? ` — ${esc(f.comment)}` : ''}</span>
          <span class="k" style="font-size:0.75rem;">${new Date(f.created_at).toLocaleDateString()}</span></div>
        `).join('');
      }
    } catch (e) {
      if (!(e instanceof AuthExpired)) $('feedback-list').innerHTML = '<p class="inline-note">Could not load feedback.</p>';
    }
  }
}

/**
 * Square status from the locations list. A locations row existing means the
 * location is *linked*, not that the Square token works — there is no
 * token-check endpoint yet, so `connected` stays null ("unknown").
 */
async function getSquareStatus(locations) {
  if (!locations.length) {
    return { isDemo: true, connected: null, label: 'Not connected', locationName: '', note: 'No locations found for this account.' };
  }
  return {
    isDemo: false,
    connected: null,
    label: 'Location linked',
    locationName: locations[0].name || '',
    note: 'Token health is not checked yet — reconnect if payments stop syncing.',
  };
}

/* ------------------------------------------------------------------ */
/* live polling (5s while the tab is visible and nothing is being edited)*/
/* ------------------------------------------------------------------ */
setInterval(() => {
  if (document.hidden) return;
  if (anyOverlayOpen()) return;
  if (!$('app-shell').classList.contains('on')) return;
  if (!token) return;
  if (currentView === 'staff' || currentView === 'devices' || currentView === 'billing' || currentView === 'settings') return;
  renderView(currentView).catch(() => { /* next tick */ });
}, 5000);

/* ------------------------------------------------------------------ */
/* event wiring + boot                                                 */
/* ------------------------------------------------------------------ */
document.querySelectorAll('.nav-item').forEach((b) => {
  b.addEventListener('click', () => showView(b.dataset.view));
});

document.querySelectorAll('[data-close]').forEach((b) => {
  b.addEventListener('click', () => closeModal(b.dataset.close));
});

document.addEventListener('click', (e) => {
  const card = e.target.closest('.floor-card');
  if (card && card.dataset.tableId) { openTableDrawer(card.dataset.tableId); return; }

  const ack = e.target.closest('[data-ack]');
  if (ack) {
    PortalAPI.ackCall(ack.dataset.ack)
      .then(() => renderView(currentView))
      .catch((err) => { if (!(err instanceof AuthExpired)) alert(err.message); });
    return;
  }

  const resAlert = e.target.closest('[data-resolve-alert]');
  if (resAlert) {
    PortalAPI.resolveServiceAlert(resAlert.dataset.resolveAlert)
      .then(() => renderView(currentView))
      .catch((err) => { if (!(err instanceof AuthExpired)) alert(err.message); });
    return;
  }

  const order = e.target.closest('[data-order]');
  if (order) { renderOrderDetail(order.dataset.order); return; }

  const retry = e.target.closest('[data-retry-orders]');
  if (retry) { renderLiveOrdersInner().catch(() => {}); return; }

  const cash = e.target.closest('[data-cash]');
  if (cash) {
    const t = tablesCache.find((x) => x.id === cash.dataset.cash);
    if (t) openTableDrawer(t.id);
    return;
  }

  const free = e.target.closest('[data-freethis]');
  if (free) {
    const t = tablesCache.find((x) => x.id === free.dataset.freethis);
    if (t) confirmFreeTable(t);
  }
});

$('drawer-close').addEventListener('click', closeDrawer);
$('btn-logout').addEventListener('click', doLogout);
$('btn-add-table').addEventListener('click', () => openModal('modal-table'));
$('invite-staff').addEventListener('click', () => openModal('modal-invite'));
$('btn-create-table').addEventListener('click', createTable);
$('report-range').addEventListener('change', () => renderReports());
$('export-excel').addEventListener('click', async () => {
  const btn = $('export-excel');
  const days = parseInt($('report-range').value, 10) || 7;
  btn.disabled = true;
  try {
    const blob = await PortalAPI.exportExcel(days);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `smart-table-report-last-${days}-days.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    if (!(e instanceof AuthExpired)) alert(e.message);
  }
  btn.disabled = false;
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearLoginError();
  const btn = $('login-btn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    await doLogin($('login-email').value.trim(), $('login-password').value);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});

// The invite button stays disabled (demo); the modal explains why.
$('btn-send-invite').addEventListener('click', (e) => e.preventDefault());

(function boot() {
  const sess = loadSession();
  if (sess) {
    token = sess.token;
    portalUser = sess.user;
    enterApp();
  } else {
    showLogin();
  }
})();
