// Smart Table — Staff Dashboard (v0.10.9)
'use strict';
// ---------------------------------------------------------------------------
// Smart Table — staff dashboard. API contract (current backend), all staff calls need `Authorization: Bearer <STAFF_API_TOKEN>`:
//   GET  /api/locations                          -> { locations:[{id,square_location_id,name,currency}] }
//   GET  /api/dashboard/overview?location_id=    -> { tables:[{id,name,state,qr_token,open_order_id,paid_cents}], waiter_calls:[{id,table_id,table_name,created_at}] }
//   GET  /api/dashboard/metrics?location_id=&days= -> { settled_checks, avg_settlement_secs|null, avg_waiter_response_secs|null, answered_calls, open_calls }
//   GET  /api/square-open-orders?location_id=    -> { orders:[{id,total_money:{amount,currency},state,created_at,items:string}] }
//   POST /api/tables | /:id/link-check {square_order_id} | /:id/free | /:id/ack-call ; GET /api/tables/:id/qr (PNG)
//   POST /api/checks/:squareOrderId/record-external-payment <- { mode, amount_cents, tip_cents, idempotency_key(UUID v4) }
//   public: GET /api/t/:qr_token -> bill of the table's open check
//   errors: { error:<message>, code?:<machine code> }
// ---------------------------------------------------------------------------
const TOKEN_KEY = 'smart_table_staff_token';
const CASH_KEY = 'st_cash_attempt';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents, cur) => {
    try { return new Intl.NumberFormat('en-CA', { style: 'currency', currency: cur || 'CAD' }).format(cents / 100); }
    catch { return (cents / 100).toFixed(2) + ' ' + esc(cur || ''); }
};
function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
    return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
}

let staffToken = null;
try { staffToken = sessionStorage.getItem(TOKEN_KEY); } catch { /* ignore */ }
let locations = [];
let dashboardData = { tables: [], waiter_calls: [] };
let selectedTable = null;
let openSquareOrders = [];
let drawerBill = null;
let pollTimer = null;
let clockTimer = null;
let cashBusy = false;
let memCash = null; // parsed cash-attempt map cache (see loadCashMap)

// ---- auth -------------------------------------------------------------------
// C3-8 (M16, documented limitation): staff authenticate with the single
// shared STAFF_API_TOKEN and logout is client-only (the token stays
// valid) — rotating STAFF_API_TOKEN on the server is the ONLY way to
// revoke access. Per-user staff sessions are the real fix and are
// deferred as an architectural change.
function showAuth(msg) {
    $('auth-error').textContent = msg || '';
    $('auth-modal').style.display = 'flex';
    $('staff-token-input').focus();
}
function stopTimers() { clearInterval(pollTimer); clearInterval(clockTimer); pollTimer = clockTimer = null; }
function lockOut(msg) {
    stopTimers();
    staffToken = null;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    showAuth(msg);
}
function saveToken() {
    const val = $('staff-token-input').value.trim();
    if (!val) return;
    staffToken = val;
    try { sessionStorage.setItem(TOKEN_KEY, val); } catch { /* ignore */ }
    $('staff-token-input').value = '';
    $('auth-modal').style.display = 'none';
    start();
}
function logout() { lockOut(''); location.reload(); }

class AuthError extends Error { constructor() { super('Unauthorized'); this.isAuth = true; } }

async function apiCall(path, options = {}) {
    if (!staffToken) { showAuth(''); throw new AuthError(); }
    const res = await fetch(path, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}), Authorization: `Bearer ${staffToken}` },
    });
    if (res.status === 401) { lockOut('Invalid or expired token. Please enter it again.'); throw new AuthError(); }
    return res;
}
async function readError(res) {
    const j = await res.json().catch(() => ({}));
    return { message: j.error || `Request failed (HTTP ${res.status})`, code: j.code };
}

// ---- bootstrap ----------------------------------------------------------------
async function start() {
    if (!staffToken) { showAuth(''); return; }
    stopTimers();
    clockTimer = setInterval(() => { $('live-clock').textContent = new Date().toLocaleTimeString(); }, 1000);
    await initDashboard();
    if (staffToken) pollTimer = setInterval(pollDashboard, 5000); // also starts after a first-time login
}

async function initDashboard() {
    try {
        const res = await apiCall('/api/locations');
        if (!res.ok) throw new Error((await readError(res)).message);
        locations = (await res.json()).locations || [];
        $('location-select').innerHTML = locations.map((l) => `<option value="${esc(l.id)}">${esc(l.name || l.id)}</option>`).join('');
        if (!locations.length) { $('tables-grid').innerHTML = '<p style="color:var(--text-muted)">No locations yet — run the seed / onboarding first.</p>'; return; }
        await loadDashboardData();
    } catch (err) {
        if (!err.isAuth) $('tables-grid').innerHTML = `<p style="color:var(--text-muted)">Could not load: ${esc(err.message)}</p>`;
    }
}

const locId = () => $('location-select').value;
const currentLoc = () => locations.find((l) => l.id === locId()) || null;
// C3-8 (M18): every dashboard fetch is stamped with the location it was
// issued for + a sequence number; a response that lands after a switch
// (or after a newer request) is dropped instead of rendering the old
// location's floor under the new location's name.
let dashSeq = 0;
let pollInFlight = false;
// C3-8 (M19): the header used to claim "● Live Connected" forever —
// poll failures were swallowed and the label was static, so staff could
// miss waiter calls through an outage. Consecutive failures now flip
// it to a visible offline state.
let pollFailures = 0;
function setConnStatus() {
    const el = $('conn-status');
    if (!el) return;
    if (pollFailures >= 3) { el.textContent = '● Connection lost — retrying'; el.style.color = 'var(--red)'; }
    else { el.textContent = '● Live Connected'; el.style.color = 'var(--green)'; }
}
function notePollResult(ok) { pollFailures = ok ? 0 : pollFailures + 1; setConnStatus(); }

// C3-8 (L19): Starter locations have no waiter-call button and no
// devices — the Waiter Calls panel and its two metrics hide for them.
function applyTierVisibility() {
    const starter = (currentLoc()?.tier || '') === 'starter';
    const panel = $('waiter-panel'); if (panel) panel.style.display = starter ? 'none' : '';
    for (const mid of ['metric-response-card', 'metric-calls-card']) { const el = $(mid); if (el) el.style.display = starter ? 'none' : ''; }
}

async function loadDashboardData() {
    const id = locId();
    if (!id) return;
    const seq = ++dashSeq;
    try {
        const q = `location_id=${encodeURIComponent(id)}`;
        const [dashRes, metricsRes] = await Promise.all([apiCall(`/api/dashboard/overview?${q}`), apiCall(`/api/dashboard/metrics?${q}&days=7`)]);
        if (seq !== dashSeq || locId() !== id) return; // stale: superseded by a newer load or a switch
        if (dashRes.ok) dashboardData = await dashRes.json();
        if (metricsRes.ok) renderMetrics(await metricsRes.json());
        renderFloor(); renderWaiterCalls(); applyTierVisibility();
        notePollResult(dashRes.ok);
    } catch (err) { if (!err.isAuth) { console.error(err); notePollResult(false); } }
}

async function pollDashboard() {
    if (document.hidden || !locId() || pollInFlight) return; // C3-8 (M18): no overlapping polls
    pollInFlight = true;
    const id = locId();
    const seq = ++dashSeq;
    try {
        const q = `location_id=${encodeURIComponent(id)}`;
        // C3-8 (L19): metrics ride the poll too — "Open Waiter Calls"
        // used to refresh only on a full load and lagged the live list.
        const [dashRes, metricsRes] = await Promise.all([apiCall(`/api/dashboard/overview?${q}`), apiCall(`/api/dashboard/metrics?${q}&days=7`)]);
        if (seq !== dashSeq || locId() !== id) return;
        if (dashRes.ok) { dashboardData = await dashRes.json(); renderFloor(); renderWaiterCalls(); }
        if (metricsRes.ok) renderMetrics(await metricsRes.json());
        notePollResult(dashRes.ok);
    } catch { notePollResult(false); /* AuthError already handled; transient errors retry on the next tick */ }
    finally { pollInFlight = false; }
}

// ---- render -------------------------------------------------------------------
function renderMetrics(m) {
    const secs = (v) => (v == null ? '—' : `${Math.round(v)}s`);
    $('m-settled').textContent = m.settled_checks ?? 0;
    $('m-settle-time').textContent = secs(m.avg_settlement_secs);
    $('m-response-time').textContent = secs(m.avg_waiter_response_secs);
    $('m-open-calls').textContent = m.open_calls ?? 0;
}

function renderFloor() {
    const grid = $('tables-grid');
    if (!dashboardData.tables || dashboardData.tables.length === 0) { grid.innerHTML = '<p style="color:var(--text-muted)">No tables found for this location.</p>'; return; }
    const calling = new Set((dashboardData.waiter_calls || []).map((c) => c.table_id));
    grid.innerHTML = dashboardData.tables.map((t) => `
        <div class="table-card ${esc(t.state)}" data-action="open-table" data-id="${esc(t.id)}">
            ${calling.has(t.id) ? '<div class="pulse-badge">!</div>' : ''}
            <div><div class="table-name">Table ${esc(t.name)}</div></div>
            <div class="table-state">${esc(t.state)}</div>
        </div>`).join('');
}

function renderWaiterCalls() {
    const calls = dashboardData.waiter_calls || [];
    $('waiter-calls-list').innerHTML = calls.length ? calls.map((c) => `
        <div class="call-item">
            <div><div style="font-weight:700;font-size:0.95rem;">Table ${esc(c.table_name || '?')}</div>
            <div style="font-size:0.75rem;color:var(--text-muted);">${Math.max(0, Math.round((Date.now() - new Date(c.created_at)) / 1000))}s ago</div></div>
            <button class="btn-ack" data-action="ack" data-id="${esc(c.table_id)}">Acknowledge</button>
        </div>`).join('') : '<p style="font-size:0.9rem;color:var(--text-muted);">No active waiter calls.</p>';
}

// ---- drawer -------------------------------------------------------------------
async function fetchTableBill(t) { // public endpoint: no staff token needed
    const res = await fetch(`/api/t/${encodeURIComponent(t.qr_token)}`);
    if (!res.ok) throw new Error((await readError(res)).message);
    return (await res.json()).check || null;
}

// C3-8 (L18): a drawer fetch is stamped with a sequence token — two
// quick taps used to be able to show table B's header over table A's
// bill when A's slower response landed last.
let drawerSeq = 0;
async function openTableDrawer(tableId) {
    const seq = ++drawerSeq;
    selectedTable = dashboardData.tables.find((t) => t.id === tableId);
    if (!selectedTable) return;
    openSquareOrders = []; drawerBill = null;
    try {
        const [ordersRes, bill] = await Promise.all([
            apiCall(`/api/square-open-orders?location_id=${encodeURIComponent(locId())}`),
            fetchTableBill(selectedTable).catch(() => null),
        ]);
        if (ordersRes.ok) openSquareOrders = (await ordersRes.json()).orders || [];
        drawerBill = bill;
    } catch (err) { if (err.isAuth) return; }
    if (seq !== drawerSeq) return; // a newer tap superseded this drawer
    renderDrawerContent();
    $('drawer-backdrop').style.display = 'flex';
}
const closeDrawer = () => { $('drawer-backdrop').style.display = 'none'; };

function renderDrawerContent() {
    const t = selectedTable;
    const billLine = drawerBill
        ? `Open check: total <strong>${money(drawerBill.total_cents, drawerBill.currency)}</strong>, remaining <strong>${money(drawerBill.remaining_cents, drawerBill.currency)}</strong>`
        : 'No check linked to this table.';
    const opts = openSquareOrders.map((o) => {
        const total = o.total_money ? money(o.total_money.amount, o.total_money.currency) : '';
        const when = o.created_at ? new Date(o.created_at).toLocaleTimeString() : '';
        const items = String(o.items || '').slice(0, 60);
        return `<option value="${esc(o.id)}">…${esc(String(o.id).slice(-6))} · ${esc(total)} · ${esc(when)} · ${esc(items)}</option>`;
    }).join('');
    $('table-drawer').innerHTML = `
        <div class="drawer-header"><h2>Table ${esc(t.name)}</h2><button class="btn-close" data-action="close-drawer">&times;</button></div>
        <p style="font-size:0.9rem;color:var(--text-muted);margin-bottom:6px;">Current State: <strong style="color:var(--navy);">${esc(t.state)}</strong></p>
        <p style="font-size:0.9rem;color:var(--text-muted);margin-bottom:16px;">${billLine}</p>

        <div style="margin-bottom:20px;">
            <label style="font-size:0.85rem;font-weight:600;color:var(--text-muted);display:block;margin-bottom:8px;">Link Square Order</label>
            <select id="link-order-select" style="width:100%;margin-bottom:8px;"><option value="">Select open order...</option>${opts}</select>
            <button class="btn-action" data-action="link">Link Order to Table</button>
        </div>

        <div style="margin-bottom:20px;">
            <label style="font-size:0.85rem;font-weight:600;color:var(--text-muted);display:block;margin-bottom:8px;">Record Cash Payment${drawerBill ? ` (${esc(drawerBill.currency)})` : ''}</label>
            <input type="number" inputmode="decimal" step="0.01" min="0" id="cash-amount" placeholder="Amount..." style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;">
            <button class="btn-secondary" id="btn-cash" data-action="cash">Record Cash Payment</button>
        </div>

        <div style="margin-bottom:20px;"><button class="btn-secondary" data-action="qr">View Table QR Code</button></div>
        <div style="margin-top:auto;"><button class="btn-danger" data-action="free">Reset / Free Table</button></div>`;
}

async function linkCheckToTable() {
    const orderId = $('link-order-select').value;
    if (!orderId) return alert('Select an order first.');
    try {
        const res = await apiCall(`/api/tables/${encodeURIComponent(selectedTable.id)}/link-check`, { method: 'POST', body: JSON.stringify({ square_order_id: orderId }) });
        if (res.ok) { closeDrawer(); loadDashboardData(); return; }
        alert((await readError(res)).message);
    } catch (e) { if (!e.isAuth) alert('Network problem — please try again.'); }
}

// ---- cash (idempotent) ----------------------------------------------------------
// C3-8 (H2): attempts are kept PER (order, amount) signature — the old
// code kept ONE global slot, so recording cash for table B overwrote
// table A's kept key, and a later retry of A minted a fresh key that
// could record A's cash twice. The map mirrors the guest page's
// per-order st_attempt_<orderId> pattern, with the same 24h TTL + sweep.
// One attempt = one key per (order, amount). The key is kept on any unknown outcome (network error / 5xx / 409 unknown),
// so tapping again replays the SAME request and can never record the cash twice; it is dropped only after a confirmed
// success or a confirmed rejection. The button is disabled for the whole request (double-tap safe).
const CASH_TTL_MS = 24 * 60 * 60 * 1000;
function loadCashMap() {
    if (memCash) return memCash;
    let m = {};
    try {
        const raw = JSON.parse(sessionStorage.getItem(CASH_KEY) || 'null');
        if (raw && typeof raw === 'object') {
            // Legacy single-slot shape {sig, key} becomes a one-entry map.
            if (typeof raw.sig === 'string' && typeof raw.key === 'string') m = { [raw.sig]: { key: raw.key, ts: Date.now() } };
            else m = raw;
        }
    } catch { m = {}; }
    const now = Date.now();
    for (const sig of Object.keys(m)) {
        const a = m[sig];
        if (!a || typeof a.key !== 'string' || !a.ts || now - a.ts > CASH_TTL_MS) delete m[sig];
    }
    memCash = m;
    return m;
}
function saveCashMap() { try { sessionStorage.setItem(CASH_KEY, JSON.stringify(memCash || {})); } catch { /* ignore */ } }
function loadCash(sig) { const a = loadCashMap()[sig]; return a ? { sig, key: a.key } : null; }
function saveCash(a) { loadCashMap()[a.sig] = { key: a.key, ts: Date.now() }; saveCashMap(); }
function clearCash(sig) { const m = loadCashMap(); if (sig) delete m[sig]; saveCashMap(); }

async function recordCash() {
    if (cashBusy) return;
    const amt = parseFloat($('cash-amount').value);
    if (!Number.isFinite(amt) || amt <= 0) return alert('Enter a valid cash amount.');
    const cents = Math.round(amt * 100);
    const btn = $('btn-cash');
    cashBusy = true; btn.disabled = true;
    try {
        const bill = await fetchTableBill(selectedTable).catch(() => null);
        if (!bill) return alert('No active check linked to this table.');
        const sig = `${bill.square_order_id}|${cents}`;
        let a = loadCash(sig);
        if (!a || a.sig !== sig) {
            // fresh attempt: validate against the live balance and confirm with the human
            if (cents > bill.remaining_cents) return alert(`That is more than the remaining balance (${money(bill.remaining_cents, bill.currency)}).`);
            if (!confirm(`Record ${money(cents, bill.currency)} cash for Table ${selectedTable.name}?\nRemaining after: ${money(bill.remaining_cents - cents, bill.currency)}`)) return;
            a = { sig, key: uuid() };
            saveCash(a);
        }
        const res = await apiCall(`/api/checks/${encodeURIComponent(bill.square_order_id)}/record-external-payment`, {
            method: 'POST',
            body: JSON.stringify({ mode: 'custom', amount_cents: cents, tip_cents: 0, idempotency_key: a.key }),
        });
        if (res.ok) { clearCash(sig); alert('Cash payment recorded.'); closeDrawer(); loadDashboardData(); return; }
        const err = await readError(res);
        if (res.status === 400 || res.status === 402 || (res.status === 409 && (err.code === 'payment_failed' || err.code === 'payment_cancelled'))) {
            clearCash(sig); alert(err.message); return; // confirmed: nothing was recorded
        }
        alert(`${err.message}\n\nThe result is not confirmed. Check the bill, then tap again — the same request is re-sent and cannot be recorded twice.`);
    } catch (e) {
        if (!e.isAuth) alert('Network problem — the result is not confirmed. Tap again: the same request is re-sent and cannot be recorded twice.');
    } finally { cashBusy = false; btn.disabled = false; }
}

async function freeTable() {
    if (!confirm(`Reset and free Table ${selectedTable.name}?${drawerBill ? '\n\nThis table still has an open check.' : ''}`)) return;
    try {
        const res = await apiCall(`/api/tables/${encodeURIComponent(selectedTable.id)}/free`, { method: 'POST' });
        if (!res.ok) return alert((await readError(res)).message);
        closeDrawer(); loadDashboardData();
    } catch (e) { if (!e.isAuth) alert('Network problem — please try again.'); }
}

async function ackCall(tableId) {
    try {
        const res = await apiCall(`/api/tables/${encodeURIComponent(tableId)}/ack-call`, { method: 'POST' });
        if (!res.ok) return alert((await readError(res)).message);
        loadDashboardData();
    } catch (e) { if (!e.isAuth) alert('Network problem — please try again.'); }
}

async function fetchAndShowQR() {
    // C3-8 (L17): the popup opens SYNCHRONOUSLY inside the click — it
    // used to open after an await, which popup blockers treat as
    // unsolicited and block.
    const w = window.open('', '_blank');
    if (!w) return alert('Please allow pop-ups to print the QR code.');
    try {
        const res = await apiCall(`/api/tables/${encodeURIComponent(selectedTable.id)}/qr`);
        if (!res.ok) { w.close(); return alert((await readError(res)).message); }
        const url = URL.createObjectURL(await res.blob());
        w.document.write(`<html><body style="text-align:center;padding:40px;"><img src="${url}" style="width:300px;"/><br/><h2>Table ${esc(selectedTable.name)}</h2><button id="qr-print" style="padding:10px 20px;font-size:1rem;margin-top:20px;">Print QR</button></body></html>`);
        w.document.close();
        // No inline onclick in the written document — wire it from here.
        const btn = w.document.getElementById('qr-print');
        if (btn) btn.addEventListener('click', () => w.print());
        setTimeout(() => URL.revokeObjectURL(url), 120000);
    } catch (e) { try { w.close(); } catch { /* ignore */ } if (!e.isAuth) alert('Network problem — please try again.'); }
}

async function addTable() {
    const name = (prompt('Enter table name (e.g. T12):') || '').trim();
    if (!name) return;
    if (name.length > 64) return alert('Table name is too long (max 64 characters).');
    try {
        const res = await apiCall('/api/tables', { method: 'POST', body: JSON.stringify({ name, location_id: locId() }) });
        if (!res.ok) return alert((await readError(res)).message);
        loadDashboardData();
    } catch (e) { if (!e.isAuth) alert('Network problem — please try again.'); }
}

// ---- events (no inline handlers: CSP-friendly) -----------------------------------
document.addEventListener('click', (e) => {
    if (e.target.id === 'drawer-backdrop') return closeDrawer();
    const el = e.target.closest('[data-action]');
    if (!el) return;
    switch (el.dataset.action) {
        case 'open-table': openTableDrawer(el.dataset.id); break;
        case 'close-drawer': closeDrawer(); break;
        case 'ack': ackCall(el.dataset.id); break;
        case 'link': linkCheckToTable(); break;
        case 'cash': recordCash(); break;
        case 'qr': fetchAndShowQR(); break;
        case 'free': freeTable(); break;
        case 'add-table': addTable(); break;
        case 'save-token': saveToken(); break;
        case 'logout': logout(); break;
        case 'reports': alert('Reports are not available yet.'); break;
    }
});
$('location-select').addEventListener('change', () => { closeDrawer(); selectedTable = null; loadDashboardData(); }); // C3-8 (M18): a switch closes the drawer
$('staff-token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveToken(); });

start();

