// Smart Table — Founder Admin (v0.2)
(function () {
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'st_admin_token';
  let token = sessionStorage.getItem(TOKEN_KEY);

  const money = (cents, cur) => {
    const c = cur || 'CAD';
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency: c }).format((cents || 0) / 100);
  };
  const time = (iso) => new Date(iso).toLocaleString();

  async function api(path) {
    const res = await fetch(path, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) { signOut(); throw new Error('Session expired'); }
    if (!res.ok) throw new Error('Request failed');
    return res.json();
  }

  function signOut() {
    token = null;
    sessionStorage.removeItem(TOKEN_KEY);
    $('login-view').classList.remove('hidden');
    $('dash-view').classList.add('hidden');
  }

  async function load() {
    try {
      const [ov, locs, pays, health] = await Promise.all([
        api('/api/admin/overview'),
        api('/api/admin/locations'),
        api('/api/admin/payments?limit=20'),
        api('/api/admin/health'),
      ]);

      $('stats').innerHTML = [
        ['Locations', ov.locations, ''],
        ['Tables', ov.tables, ''],
        ['Open checks', ov.open_checks, ov.open_checks > 0 ? 'warn' : 'ok'],
        ['Payments 24h', ov.payments_24h, ''],
        ['Revenue 24h', money(ov.revenue_24h_cents), 'ok'],
        ['Stuck pending', ov.stuck_pending ?? health.stuck_pending, (health.stuck_pending > 0) ? 'bad' : 'ok'],
      ].map(([l, v, c]) => `<div class="stat-card"><div class="label">${l}</div><div class="value ${c}">${v}</div></div>`).join('');

      $('locations-body').innerHTML = locs.locations.map((l) => `
        <tr>
          <td>${esc(l.name)}</td>
          <td>${esc(l.pos_type)}</td>
          <td>${l.tables}</td>
          <td>${l.open_checks}</td>
          <td>${money(l.revenue_24h_cents, l.currency)}</td>
          <td><span class="badge ${l.qr_ordering_enabled ? 'on' : 'off'}">${l.qr_ordering_enabled ? 'ON' : 'OFF'}</span></td>
          <td><span class="badge ${l.loyalty_enabled ? 'on' : 'off'}">${l.loyalty_enabled ? 'ON' : 'OFF'}</span></td>
        </tr>`).join('') || '<tr><td colspan="7">No locations yet.</td></tr>';

      $('payments-body').innerHTML = pays.payments.map((p) => `
        <tr>
          <td>${time(p.created_at)}</td>
          <td>${esc(p.location_name || '—')}</td>
          <td>${esc(p.table_name || '—')}</td>
          <td>${money(p.amount_cents + p.tip_cents, p.currency)}</td>
          <td>${esc(p.status)}</td>
        </tr>`).join('') || '<tr><td colspan="5">No payments yet.</td></tr>';

      $('health-body').innerHTML = `
        <tr><td>Stuck PENDING payments (&gt;10 min)</td><td>${health.stuck_pending}</td></tr>
        <tr><td>FAILED payments (24h)</td><td>${health.failed_24h}</td></tr>
        <tr><td>Server uptime</td><td>${Math.round(health.uptime / 60)} min</td></tr>`;
    } catch (e) {
      if (e.message !== 'Session expired') alert('Failed to load: ' + e.message);
    }
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  $('login-btn').addEventListener('click', async () => {
    const t = $('token-input').value.trim();
    if (!t) return;
    token = t;
    try {
      await api('/api/admin/overview');
      sessionStorage.setItem(TOKEN_KEY, t);
      $('login-error').classList.add('hidden');
      $('login-view').classList.add('hidden');
      $('dash-view').classList.remove('hidden');
      load();
      setInterval(load, 30000);
    } catch {
      token = null;
      $('login-error').textContent = 'Invalid token.';
      $('login-error').classList.remove('hidden');
    }
  });
  $('token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('login-btn').click(); });
  $('logout-btn').addEventListener('click', signOut);

  if (token) {
    $('login-view').classList.add('hidden');
    $('dash-view').classList.remove('hidden');
    load();
    setInterval(load, 30000);
  }
})();
