// Smart Table — Founder Admin (v0.8.13)
(function () {
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'st_admin_token';
  let token = sessionStorage.getItem(TOKEN_KEY);
  let pollTimer = null;
  let loadInFlight = false;

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  // F10-4: a malformed currency code from any POS must never break the
  // whole dashboard — fall back to a plain escaped "amount CODE" string.
  const money = (cents, cur) => {
    const c = cur || 'CAD';
    try {
      return new Intl.NumberFormat('en-CA', { style: 'currency', currency: c }).format((cents || 0) / 100);
    } catch {
      return esc(c) + ' ' + (num(cents) / 100).toFixed(2);
    }
  };
  const time = (iso) => new Date(iso).toLocaleString();

  async function api(path) {
    const res = await fetch(path, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) { signOut(); throw new Error('Session expired'); }
    if (!res.ok) throw new Error('Request failed');
    return res.json();
  }

  // F10-14: the analytics route distinguishes "not configured" from a
  // fetch failure in its error body — read it instead of guessing.
  async function apiAnalytics() {
    const res = await fetch('/api/admin/analytics', { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) { signOut(); throw new Error('Session expired'); }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(/not configured/i.test(String(data.error || '')) ? 'not-configured' : 'Request failed');
    }
    return res.json();
  }

  // F10-7: exactly one polling interval, cleared on sign-out.
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(load, 30000);
  }
  function stopPolling() {
    if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  }

  function signOut() {
    const t = token;
    token = null;
    sessionStorage.removeItem(TOKEN_KEY);
    stopPolling();
    // F10-2: invalidate the founder session server-side (best effort) —
    // clearing the local copy alone left it valid for hours.
    if (t) {
      fetch('/api/admin/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t } }).catch(() => {});
    }
    $('username-input').value = '';
    $('token-input').value = '';
    $('stats').innerHTML = '';
    $('locations-body').innerHTML = '';
    $('payments-body').innerHTML = '';
    $('health-body').innerHTML = '';
    $('analytics-body').innerHTML = '';
    $('load-error').classList.add('hidden');
    $('login-view').classList.remove('hidden');
    $('dash-view').classList.add('hidden');
  }

  async function load() {
    if (loadInFlight) return;
    loadInFlight = true;
    try {
      const [ov, locs, pays, health] = await Promise.all([
        api('/api/admin/overview'),
        api('/api/admin/locations'),
        api('/api/admin/payments?limit=20'),
        api('/api/admin/health'),
      ]);

      // Website analytics (best effort — may be unconfigured).
      try {
        const an = await apiAnalytics();
        $('analytics-body').innerHTML = (an.daily || []).map((d) => `
          <tr><td>${esc(d.date)}</td><td>${num(d.visitors)}</td><td>${num(d.pageviews)}</td></tr>
        `).join('') || '<tr><td colspan="3">No data yet.</td></tr>';
      } catch (e) {
        $('analytics-body').innerHTML = `<tr><td colspan="3">${e && e.message === 'not-configured' ? 'Analytics not configured.' : 'Analytics unavailable — could not load the data.'}</td></tr>`;
      }

      // F10-5: revenue is summed per currency by the API and labeled
      // with its real currency — never one mixed sum labeled CAD.
      const revByCur = Array.isArray(ov.revenue_24h_by_currency) ? ov.revenue_24h_by_currency : [];
      const revenue = revByCur.length
        ? revByCur.map((r) => money(num(r.total_cents), r.currency) + ' ' + esc(r.currency || 'CAD')).join(' + ')
        : money(ov.revenue_24h_cents);

      $('stats').innerHTML = [
        ['Locations', num(ov.locations), ''],
        ['Tables', num(ov.tables), ''],
        ['Open checks', num(ov.open_checks), ''],
        ['Payments 24h', num(ov.payments_24h), ''],
        ['Revenue 24h', revenue, 'ok'],
        ['Stuck pending', num(ov.stuck_pending ?? health.stuck_pending), (num(health.stuck_pending) > 0) ? 'bad' : 'ok'],
      ].map(([l, v, c]) => `<div class="stat-card"><div class="label">${l}</div><div class="value ${c}">${v}</div></div>`).join('');

      $('locations-body').innerHTML = locs.locations.map((l) => `
        <tr>
          <td>${esc(l.name)}</td>
          <td>${esc(l.pos_type)}</td>
          <td>${num(l.tables)}</td>
          <td>${num(l.open_checks)}</td>
          <td>${money(l.revenue_24h_cents, l.currency)}</td>
          <td><span class="badge ${l.qr_ordering_enabled ? 'on' : 'off'}">${l.qr_ordering_enabled ? 'ON' : 'OFF'}</span></td>
          <td><span class="badge ${l.loyalty_enabled ? 'on' : 'off'}">${l.loyalty_enabled ? 'ON' : 'OFF'}</span></td>
          <td>${esc(l.billing_plan || 'commission')}${l.subscription_status ? ' (' + esc(l.subscription_status) + ')' : ''}</td>
          <td>${money(Number(l.fees_this_month_cents || 0), l.currency)}</td>
          <td>${money(Number(l.fees_accrued_cents || 0), l.currency)}</td>
        </tr>`).join('') || '<tr><td colspan="10">No locations yet.</td></tr>';

      $('payments-body').innerHTML = pays.payments.map((p) => `
        <tr>
          <td>${time(p.created_at)}</td>
          <td>${esc(p.location_name || '—')}</td>
          <td>${esc(p.table_name || '—')}</td>
          <td>${money(num(p.amount_cents) + num(p.tip_cents), p.currency)}</td>
          <td>${esc(p.status)}</td>
        </tr>`).join('') || '<tr><td colspan="5">No payments yet.</td></tr>';

      $('health-body').innerHTML = `
        <tr><td>Stuck PENDING payments (&gt;10 min)</td><td>${num(health.stuck_pending)}</td></tr>
        <tr><td>FAILED payments (24h)</td><td>${num(health.failed_24h)}</td></tr>
        <tr><td>Server uptime</td><td>${Math.round(num(health.uptime) / 60)} min</td></tr>`;

      $('load-error').classList.add('hidden');
    } catch (e) {
      // F10-4: an inline banner, never a blocking alert that repeats
      // on every poll tick.
      if (e.message !== 'Session expired') {
        $('load-error').textContent = 'Failed to load: ' + e.message;
        $('load-error').classList.remove('hidden');
      }
    } finally {
      loadInFlight = false;
    }
  }

  $('login-btn').addEventListener('click', async () => {
    const username = $('username-input').value.trim();
    const password = $('token-input').value;
    if (!username || !password) return;
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Login failed');
      token = data.token;
      sessionStorage.setItem(TOKEN_KEY, token);
      // F10-2: the password does not stay in the DOM after login.
      $('token-input').value = '';
      $('login-error').classList.add('hidden');
      $('login-view').classList.add('hidden');
      $('dash-view').classList.remove('hidden');
      load();
      startPolling();
    } catch (e) {
      token = null;
      $('login-error').textContent = e.message || 'Invalid credentials.';
      $('login-error').classList.remove('hidden');
    }
  });
  $('token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('login-btn').click(); });
  $('logout-btn').addEventListener('click', signOut);

  if (token) {
    $('login-view').classList.add('hidden');
    $('dash-view').classList.remove('hidden');
    load();
    startPolling();
  }
})();
