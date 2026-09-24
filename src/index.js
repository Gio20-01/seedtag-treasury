import { readSheetTab, upsertPermissionListRow, appendSheetRows } from './sheets.js';
import { matchAndEvaluate, findEmailKey } from './matching.js';

const ROLE_RANK = { 'SuperAdminExtra': 4, 'SuperAdmin': 3, 'Admin': 2, 'Treasury Ops': 1 };

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': getAllowedOrigin(origin) || '',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Impersonate',
  };
}
function getAllowedOrigin(origin) {
  if (!origin) return null;
  if (origin.endsWith('.pages.dev')) return origin;
  if (origin.endsWith('.google.com')) return origin;
  if (origin.endsWith('.googleusercontent.com')) return origin;
  if (origin === 'https://peoplehub.seedtag.com') return origin;
  return null; // mai wildcard
}
function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });
}

// ------------------------------------------------------------
// Role resolution: User_Management (read-only) + Permission_list overlay
// stesso identico pattern di checkAuthorized() in seedtag-hrdashboard
// ------------------------------------------------------------
async function resolveRole(accessToken, sheetId, email) {
  const emailLower = String(email || '').toLowerCase().trim();

  const umRows = await readSheetTab(accessToken, sheetId, 'User_Management');
  const baseMap = {};
  umRows.forEach((r) => {
    const e = String(r.Email || '').toLowerCase().trim();
    if (e) baseMap[e] = { email: e, employee: r['First name'] || '', role: (r.Role || '').trim() };
  });

  const overrideMap = {};
  try {
    const plRows = await readSheetTab(accessToken, sheetId, 'Permission_list');
    plRows.forEach((r) => {
      const e = String(r.Email || '').toLowerCase().trim();
      if (e && r.Role) overrideMap[e] = { email: e, employee: r.Employee || (baseMap[e] && baseMap[e].employee) || '', role: r.Role };
    });
  } catch (e) { /* Permission_list vuoto/assente -> nessun override */ }

  const merged = { ...baseMap, ...overrideMap };
  const fullList = Object.values(merged);
  const list = fullList.filter((r) => r.role && ROLE_RANK[r.role]);

  const match = list.find((r) => r.email === emailLower);
  return { role: match ? match.role : null, fullList, list };
}

function requireRole(resolved, minRole) {
  if (!resolved || !resolved.role) return false;
  return (ROLE_RANK[resolved.role] || 0) >= (ROLE_RANK[minRole] || 999);
}

// ------------------------------------------------------------
// Router
// ------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });

    // Prima barriera, sempre, subito dopo OPTIONS
    const internalAuth = request.headers.get('X-Internal-Auth');
    if (!internalAuth || internalAuth !== env.INTERNAL_SECRET) {
      return json({ error: 'forbidden' }, 403, origin);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    const userEmail = request.headers.get('X-User-Email');
    const accessToken = request.headers.get('X-SA-Token');

    try {
      const resolved = await resolveRole(accessToken, env.SHEET_ID, userEmail);

      if (path === '/api/treasury/me' && request.method === 'GET') {
        return json({ email: userEmail, role: resolved.role }, 200, origin);
      }

      if (path === '/api/treasury/access-requests' && request.method === 'POST') {
        return await createAccessRequest(request, env, userEmail, origin);
      }

      // Chiamato dal GAS import (via Centrale, server-to-server - vedi
      // Pattern_SA_Token_Relay.md) subito dopo ogni import di Personio,
      // giornaliero o on-demand. Nessun utente reale, quindi nessun ruolo da
      // controllare qui - solo il secret dedicato, letto dal body.
      if (path === '/api/treasury/internal/ingest-changelog' && request.method === 'POST') {
        const body = await request.json();
        if (body.secret !== env.TREASURY_IMPORT_GAS_SECRET) return json({ error: 'unauthorized' }, 401, origin);
        const s2sToken = request.headers.get('X-SA-Token'); // il Centrale lo passa anche nelle chiamate server-to-server
        await runDailyChangelogDiff(env, body.bankRows || [], body.adjRows || [], s2sToken);
        await refreshCacheFrom(env, body.bankRows || [], body.adjRows || []);
        return json({ ok: true }, 200, origin);
      }

      if (!requireRole(resolved, 'Treasury Ops')) {
        return json({ error: 'no role assigned' }, 403, origin);
      }

      if (path === '/api/treasury/overview' && request.method === 'GET') {
        return await getOverviewStats(env, accessToken, origin, url.searchParams.get('force') === '1');
      }
      if (path === '/api/treasury/roster-check' && request.method === 'GET') {
        return await getRosterCheck(env, accessToken, origin, url.searchParams.get('force') === '1');
      }
      if (path === '/api/treasury/field-map' && request.method === 'GET') {
        const { REQUIREMENTS } = await import('./matching.js');
        return json({ requirements: REQUIREMENTS }, 200, origin);
      }
      if (path === '/api/treasury/requests' && request.method === 'GET') {
        return await listRequests(env, origin);
      }
      if (path === '/api/treasury/requests' && request.method === 'POST') {
        return await createRequest(request, env, userEmail, origin);
      }
      const detailMatch = path.match(/^\/api\/treasury\/requests\/(\d+)$/);
      if (detailMatch && request.method === 'GET') {
        return await getRequestDetail(env, Number(detailMatch[1]), origin);
      }
      if (detailMatch && request.method === 'DELETE') {
        if (!requireRole(resolved, 'Admin')) return json({ error: 'forbidden' }, 403, origin);
        return await deleteRequest(env, Number(detailMatch[1]), userEmail, origin);
      }
      const employeesMatch = path.match(/^\/api\/treasury\/requests\/(\d+)\/employees$/);
      if (employeesMatch && request.method === 'POST') {
        return await addEmployees(request, env, accessToken, Number(employeesMatch[1]), userEmail, origin);
      }
      const resolveAmbigMatch = path.match(/^\/api\/treasury\/requests\/(\d+)\/employees\/(\d+)\/resolve-ambiguous$/);
      if (resolveAmbigMatch && request.method === 'POST') {
        return await resolveAmbiguous(request, env, accessToken, Number(resolveAmbigMatch[1]), Number(resolveAmbigMatch[2]), origin);
      }
      const emailMatch = path.match(/^\/api\/treasury\/requests\/(\d+)\/email$/);
      if (emailMatch && request.method === 'POST') {
        return await sendEmails(request, env, accessToken, Number(emailMatch[1]), userEmail, origin);
      }

      // On-demand refresh dei dati Personio (oltre al trigger giornaliero GAS)
      if (path === '/api/treasury/refresh-personio' && request.method === 'POST') {
        if (!requireRole(resolved, 'Admin')) return json({ error: 'forbidden' }, 403, origin);
        return await refreshPersonioNow(env, origin);
      }

      // Quick check ad-hoc: valuta una lista senza creare/salvare nessuna richiesta
      if (path === '/api/treasury/quick-check' && request.method === 'POST') {
        return await quickCheck(request, env, accessToken, origin);
      }

      // ── Admin-only: user/role management, access request resolution ──
      if (path === '/api/treasury/config/users' && request.method === 'GET') {
        if (!requireRole(resolved, 'SuperAdmin')) return json({ error: 'forbidden' }, 403, origin);
        return await listUsers(resolved, origin);
      }
      if (path === '/api/treasury/config/users' && request.method === 'POST') {
        if (!requireRole(resolved, 'SuperAdmin')) return json({ error: 'forbidden' }, 403, origin);
        return await updateUserRole(request, env, accessToken, resolved, userEmail, origin);
      }
      if (path === '/api/treasury/config/access-requests' && request.method === 'GET') {
        if (!requireRole(resolved, 'SuperAdmin')) return json({ error: 'forbidden' }, 403, origin);
        return await listAccessRequests(env, origin);
      }
      if (path === '/api/treasury/config/settings' && request.method === 'GET') {
        if (!requireRole(resolved, 'SuperAdmin')) return json({ error: 'forbidden' }, 403, origin);
        return await listSettings(env, origin);
      }
      if (path === '/api/treasury/config/settings' && request.method === 'POST') {
        if (!requireRole(resolved, 'SuperAdmin')) return json({ error: 'forbidden' }, 403, origin);
        return await updateSetting(request, env, userEmail, origin);
      }
      const resolveAccessMatch = path.match(/^\/api\/treasury\/config\/access-requests\/(\d+)\/resolve$/);
      if (resolveAccessMatch && request.method === 'POST') {
        if (!requireRole(resolved, 'SuperAdmin')) return json({ error: 'forbidden' }, 403, origin);
        return await resolveAccessRequest(request, env, accessToken, Number(resolveAccessMatch[1]), userEmail, origin);
      }
      if (path === '/api/treasury/config/audit-log' && request.method === 'GET') {
        if (resolved.role !== 'SuperAdminExtra') return json({ error: 'forbidden' }, 403, origin);
        const { results } = await env.DB.prepare(
          'SELECT * FROM treasury_audit_log ORDER BY created_at DESC LIMIT 200'
        ).all();
        return json({ entries: results }, 200, origin);
      }
      if (path === '/api/treasury/config/deleted-requests' && request.method === 'GET') {
        if (resolved.role !== 'SuperAdminExtra') return json({ error: 'forbidden' }, 403, origin);
        const { results } = await env.DB.prepare(
          "SELECT * FROM treasury_requests WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
        ).all();
        return json({ requests: results }, 200, origin);
      }

      return json({ error: 'not found' }, 404, origin);
    } catch (err) {
      return json({ error: err.message }, 500, origin);
    }
  },

  // Rete di sicurezza indipendente dal GAS: se per qualche motivo il GAS non
  // gira un giorno (trigger fallito, errore Personio, ecc.), la cache non
  // resta comunque ferma per sempre. Pattern B (vedi Pattern_SA_Token_Relay.md):
  // GOOGLE_SA_KEY dedicato, usato SOLO qui - tutte le richieste utente normali
  // continuano a usare X-SA-Token dal Centrale come sempre.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const accessToken = await getCronAccessToken(env);
        const [bankRows, adjRows] = await Promise.all([
          readSheetTab(accessToken, env.OPERATIONAL_SHEET_ID, 'Personio Bank Data'),
          readSheetTab(accessToken, env.SHEET_ID, env.ADJDATA_TAB)
        ]);
        await refreshCacheFrom(env, bankRows, adjRows);
      } catch (e) { console.error('[scheduled cache refresh]', e.message); }
    })());
  }
};

async function getCronAccessToken(env) {
  const sa = JSON.parse(env.GOOGLE_SA_KEY);
  const now = Math.floor(Date.now() / 1000);
  const b64url = (obj) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unsigned = b64url({ alg: 'RS256', typ: 'JWT' }) + '.' + b64url({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  });
  const pemBody = sa.private_key.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\n/g, '');
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsigned));
  const sig64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + unsigned + '.' + sig64
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(JSON.stringify(data));
  return data.access_token;
}

// ------------------------------------------------------------
// Access requests (no-role users)
// ------------------------------------------------------------
async function createAccessRequest(request, env, userEmail, origin) {
  const body = await request.json();
  await env.DB.prepare(
    'INSERT INTO treasury_access_requests (email, name, reason) VALUES (?, ?, ?)'
  ).bind(userEmail || body.email, body.name || '', body.reason || '').run();
  return json({ ok: true }, 200, origin);
}

async function listAccessRequests(env, origin) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM treasury_access_requests WHERE status = 'pending' ORDER BY requested_at DESC"
  ).all();
  return json({ requests: results }, 200, origin);
}

async function resolveAccessRequest(request, env, accessToken, id, actorEmail, origin) {
  const body = await request.json(); // { decision: 'approved'|'rejected', note, role, employee }
  const decision = body.decision === 'approved' ? 'approved' : 'rejected';

  if (body.role === 'SuperAdminExtra') {
    return json({ error: 'cannot assign SuperAdminExtra' }, 403, origin);
  }

  const reqRow = await env.DB.prepare('SELECT * FROM treasury_access_requests WHERE id = ?').bind(id).first();
  if (!reqRow) return json({ error: 'not found' }, 404, origin);

  await env.DB.prepare(
    "UPDATE treasury_access_requests SET status = ?, note = ?, resolved_at = datetime('now'), resolved_by = ? WHERE id = ?"
  ).bind(decision, body.note || '', actorEmail, id).run();

  if (decision === 'approved' && body.role) {
    await upsertPermissionListRow(accessToken, env.SHEET_ID, reqRow.email, body.employee || reqRow.name || '', body.role);
  }
  await logAudit(env, actorEmail, 'access_request_resolved', { email: reqRow.email, decision, role: body.role || null });

  return json({ ok: true }, 200, origin);
}

// ------------------------------------------------------------
// User/role management (Config panel) - SuperAdminExtra sempre nascosto,
// mai editabile da un SuperAdmin normale
// ------------------------------------------------------------
async function listUsers(resolved, origin) {
  const visible = resolved.list.filter((r) => r.role !== 'SuperAdminExtra' || resolved.role === 'SuperAdminExtra');
  return json({ users: visible }, 200, origin);
}

async function updateUserRole(request, env, accessToken, resolved, actorEmail, origin) {
  const body = await request.json(); // { email, employee, role } - role='' per rimuovere
  if (body.role === 'SuperAdminExtra' && resolved.role !== 'SuperAdminExtra') {
    return json({ error: 'cannot assign SuperAdminExtra' }, 403, origin);
  }
  const targetCurrent = resolved.list.find((r) => r.email === String(body.email || '').toLowerCase().trim());
  if (targetCurrent && targetCurrent.role === 'SuperAdminExtra' && resolved.role !== 'SuperAdminExtra') {
    return json({ error: 'cannot modify SuperAdminExtra' }, 403, origin);
  }
  await upsertPermissionListRow(accessToken, env.SHEET_ID, body.email, body.employee || '', body.role || '');
  await logAudit(env, actorEmail, 'user_role_changed', { email: body.email, role: body.role || '(removed)' });
  return json({ ok: true }, 200, origin);
}

// ------------------------------------------------------------
// Settings modificabili dalla webapp (Config panel) - niente redeploy per
// cambiare valori come l'email CC di test.
// ------------------------------------------------------------
async function listSettings(env, origin) {
  const { results } = await env.DB.prepare('SELECT key, value, updated_at, updated_by FROM treasury_settings').all();
  return json({ settings: results }, 200, origin);
}

async function updateSetting(request, env, actorEmail, origin) {
  const body = await request.json(); // { key, value }
  if (!body.key) return json({ error: 'key required' }, 400, origin);
  await env.DB.prepare(
    `INSERT INTO treasury_settings (key, value, updated_by) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`
  ).bind(body.key, body.value ?? '', actorEmail).run();
  await logAudit(env, actorEmail, 'setting_changed', { key: body.key });
  return json({ ok: true }, 200, origin);
}

async function getSetting(env, key, fallback) {
  const row = await env.DB.prepare('SELECT value FROM treasury_settings WHERE key = ?').bind(key).first();
  return row && row.value ? row.value : fallback;
}

const CACHE_KEY_OVERVIEW = 'treasury:cache:overview:v1';
const CACHE_KEY_ROSTER = 'treasury:cache:roster:v1';

async function getOverviewStats(env, accessToken, origin, force) {
  if (!force && env.CACHE) {
    try {
      const cached = await env.CACHE.get(CACHE_KEY_OVERVIEW, { type: 'json' });
      if (cached) return json(cached, 200, origin);
    } catch (e) { /* fallback a lettura live sotto */ }
  }
  const [bankRows, adjRows] = await Promise.all([
    readSheetTab(accessToken, env.OPERATIONAL_SHEET_ID, 'Personio Bank Data'),
    readSheetTab(accessToken, env.SHEET_ID, env.ADJDATA_TAB)
  ]);
  const { evaluateRoster } = await import('./matching.js');
  const byCountry = evaluateRoster(bankRows, adjRows);
  const payload = { byCountry, generatedAt: new Date().toISOString() };
  if (env.CACHE) { try { await env.CACHE.put(CACHE_KEY_OVERVIEW, JSON.stringify(payload)); } catch (e) {} }
  return json(payload, 200, origin);
}

// "Check Employees" globale (Overview) - TUTTI gli employee del roster,
// nessun paste. Mai valori bancari, solo nomi dei campi mancanti.
async function getRosterCheck(env, accessToken, origin, force) {
  if (!force && env.CACHE) {
    try {
      const cached = await env.CACHE.get(CACHE_KEY_ROSTER, { type: 'json' });
      if (cached) return json(cached, 200, origin);
    } catch (e) {}
  }
  const [bankRows, adjRows] = await Promise.all([
    readSheetTab(accessToken, env.OPERATIONAL_SHEET_ID, 'Personio Bank Data'),
    readSheetTab(accessToken, env.SHEET_ID, env.ADJDATA_TAB)
  ]);
  const { evaluateRosterDetailed } = await import('./matching.js');
  const result = evaluateRosterDetailed(bankRows, adjRows);
  const payload = { ...result, generatedAt: new Date().toISOString() };
  if (env.CACHE) { try { await env.CACHE.put(CACHE_KEY_ROSTER, JSON.stringify(payload)); } catch (e) {} }
  return json(payload, 200, origin);
}

// Ricalcola e salva entrambe le cache da dati già in mano (bankRows/adjRows) -
// usata sia dall'ingest-changelog (dati appena spinti dal GAS) sia dal cron
// delle 3am come rete di sicurezza indipendente.
async function refreshCacheFrom(env, bankRows, adjRows) {
  const { evaluateRoster, evaluateRosterDetailed } = await import('./matching.js');
  const now = new Date().toISOString();
  const overviewPayload = { byCountry: evaluateRoster(bankRows, adjRows), generatedAt: now };
  const rosterPayload = { ...evaluateRosterDetailed(bankRows, adjRows), generatedAt: now };
  if (env.CACHE) {
    await env.CACHE.put(CACHE_KEY_OVERVIEW, JSON.stringify(overviewPayload));
    await env.CACHE.put(CACHE_KEY_ROSTER, JSON.stringify(rosterPayload));
  }
}

// ------------------------------------------------------------
// Monthly requests
// ------------------------------------------------------------
async function logAudit(env, actorEmail, action, detail) {
  try {
    await env.DB.prepare(
      'INSERT INTO treasury_audit_log (actor_email, action, detail) VALUES (?, ?, ?)'
    ).bind(actorEmail, action, JSON.stringify(detail || {})).run();
  } catch (e) { /* non bloccante - l'audit non deve mai rompere l'azione vera */ }
}

async function listRequests(env, origin) {
  const { results } = await env.DB.prepare(
    "SELECT id, month_label, payment_date, status, created_at FROM treasury_requests WHERE deleted_at IS NULL ORDER BY payment_date DESC"
  ).all();
  return json({ requests: results }, 200, origin);
}

async function createRequest(request, env, userEmail, origin) {
  const body = await request.json();
  const result = await env.DB.prepare(
    `INSERT INTO treasury_requests (month_label, payment_date, personio_deadline_1, personio_deadline_2, created_by)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(body.month_label, body.payment_date, body.personio_deadline_1 || null, body.personio_deadline_2 || null, userEmail).run();
  await logAudit(env, userEmail, 'request_created', { id: result.meta.last_row_id, month_label: body.month_label });
  return json({ ok: true, id: result.meta.last_row_id }, 200, origin);
}

async function deleteRequest(env, id, userEmail, origin) {
  const req = await env.DB.prepare('SELECT month_label FROM treasury_requests WHERE id = ?').bind(id).first();
  if (!req) return json({ error: 'not found' }, 404, origin);
  await env.DB.prepare(
    "UPDATE treasury_requests SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?"
  ).bind(userEmail, id).run();
  await logAudit(env, userEmail, 'request_deleted', { id, month_label: req.month_label });
  return json({ ok: true }, 200, origin);
}

async function getRequestDetail(env, id, origin) {
  const request = await env.DB.prepare('SELECT * FROM treasury_requests WHERE id = ?').bind(id).first();
  if (!request) return json({ error: 'not found' }, 404, origin);

  const { results: employees } = await env.DB.prepare(
    'SELECT * FROM treasury_request_employees WHERE request_id = ? ORDER BY country, input_name'
  ).bind(id).all();

  const statusCounts = {};
  employees.forEach((e) => { statusCounts[e.status] = (statusCounts[e.status] || 0) + 1; });

  return json({ request, employees, statusCounts }, 200, origin);
}

async function quickCheck(request, env, accessToken, origin) {
  const body = await request.json();
  const inputRows = (body.rows || []).map((r) => ({
    name: r.name || '',
    email: r.email || (r[findEmailKey(r)] || '')
  }));

  const [bankRows, adjRows] = await Promise.all([
    readSheetTab(accessToken, env.OPERATIONAL_SHEET_ID, 'Personio Bank Data'),
    readSheetTab(accessToken, env.SHEET_ID, env.ADJDATA_TAB)
  ]);
  const evaluated = matchAndEvaluate(bankRows, adjRows, inputRows);
  return json({ employees: evaluated }, 200, origin);
}

async function addEmployees(request, env, accessToken, requestId, actorEmail, origin) {
  const body = await request.json();
  const inputRows = (body.rows || []).map((r) => ({
    name: r.name || '',
    email: r.email || (r[findEmailKey(r)] || '')
  }));

  const [bankRows, adjRows] = await Promise.all([
    readSheetTab(accessToken, env.OPERATIONAL_SHEET_ID, 'Personio Bank Data'),
    readSheetTab(accessToken, env.SHEET_ID, env.ADJDATA_TAB)
  ]);
  const evaluated = matchAndEvaluate(bankRows, adjRows, inputRows);

  const stmt = env.DB.prepare(
    `INSERT INTO treasury_request_employees
     (request_id, input_name, input_email, matched_email, matched_by, country, status, missing_mandatory, missing_optional, ambiguous_candidates, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  );
  const batch = evaluated.map((e) => stmt.bind(
    requestId, e.input_name, e.input_email, e.matched_email, e.matched_by,
    e.country, e.status, e.missing_mandatory, e.missing_optional, e.ambiguous_candidates
  ));
  await env.DB.batch(batch);
  await logAudit(env, actorEmail, 'employees_added', { requestId, count: evaluated.length });

  return json({ ok: true, count: evaluated.length }, 200, origin);
}

// Ambiguous: il match per nome ha trovato più candidati email. Treasury Ops
// sceglie quello giusto qui, e la riga viene rivalutata con quell'email
// come se fosse arrivata già corretta dall'inizio (matched_by='confirmed').
async function resolveAmbiguous(request, env, accessToken, requestId, employeeRowId, origin) {
  const body = await request.json(); // { chosenEmail }
  const chosenEmail = String(body.chosenEmail || '').trim().toLowerCase();
  if (!chosenEmail) return json({ error: 'chosenEmail required' }, 400, origin);

  const [bankRows, adjRows] = await Promise.all([
    readSheetTab(accessToken, env.OPERATIONAL_SHEET_ID, 'Personio Bank Data'),
    readSheetTab(accessToken, env.SHEET_ID, env.ADJDATA_TAB)
  ]);
  const [evaluated] = matchAndEvaluate(bankRows, adjRows, [{ name: '', email: chosenEmail }]);

  await env.DB.prepare(
    `UPDATE treasury_request_employees SET
       matched_email = ?, matched_by = 'confirmed', country = ?, status = ?,
       missing_mandatory = ?, missing_optional = ?, ambiguous_candidates = '', last_synced_at = datetime('now')
     WHERE id = ? AND request_id = ?`
  ).bind(evaluated.matched_email, evaluated.country, evaluated.status, evaluated.missing_mandatory, evaluated.missing_optional, employeeRowId, requestId).run();

  return json({ ok: true }, 200, origin);
}

// ------------------------------------------------------------
// Refresh Personio on-demand: chiama il GAS Personio Import, deployato
// anche come Web App (oltre al trigger giornaliero), protetto da secret.
// ------------------------------------------------------------
async function refreshPersonioNow(env, origin) {
  try {
    const resp = await fetch(env.TREASURY_IMPORT_GAS_URL + '?secret=' + encodeURIComponent(env.TREASURY_IMPORT_GAS_SECRET));
    const respJson = await resp.json();
    return json({ ok: !!respJson.ok, detail: respJson }, respJson.ok ? 200 : 502, origin);
  } catch (e) {
    return json({ ok: false, error: e.message }, 502, origin);
  }
}

// ------------------------------------------------------------
// Emails - calls the standalone Treasury_Email_Sender.gs webapp
// ------------------------------------------------------------
// Mappa status -> tipo di email applicabile, usata da type='auto'. null = non
// applicabile (nessuna email da mandare per questo status - inactive, leave, ecc).
function autoEmailTypeFor(status) {
  if (status === 'MISSING_MANDATORY') return 'missing_mandatory';
  if (status === 'OK_MISSING_OPTIONAL') return 'optional_reminder';
  if (status === 'OK') return 'confirm';
  return null;
}

async function sendEmails(request, env, accessToken, requestId, actorEmail, origin) {
  const body = await request.json();
  const reqRow = await env.DB.prepare('SELECT month_label FROM treasury_requests WHERE id = ?').bind(requestId).first();
  if (!reqRow) return json({ error: 'request not found' }, 404, origin);

  const ccOverride = await getSetting(env, 'treasury_cc', ''); // '' = usa il default hardcoded nel GAS
  const isAuto = body.type === 'auto';

  // Nickname per il saluto ("Hey <Nickname>") - da User_Management, non da AdjData
  const umRows = await readSheetTab(accessToken, env.SHEET_ID, 'User_Management').catch(() => []);
  const nicknameByEmail = {};
  umRows.forEach((r) => {
    const e = String(r.Email || '').trim().toLowerCase();
    if (e) nicknameByEmail[e] = r.Nickname || r['First name'] || '';
  });

  const placeholders = body.employeeIds.map(() => '?').join(',');
  const { results: employees } = await env.DB.prepare(
    `SELECT * FROM treasury_request_employees WHERE request_id = ? AND id IN (${placeholders})`
  ).bind(requestId, ...body.employeeIds).all();

  const outcomes = [];
  for (const emp of employees) {
    const effectiveType = isAuto ? autoEmailTypeFor(emp.status) : body.type;
    if (!effectiveType) {
      outcomes.push({ email: emp.matched_email || emp.input_email, ok: false, skipped: true, reason: 'no applicable template for status ' + emp.status });
      continue;
    }

    const empEmailLower = String(emp.matched_email || emp.input_email || '').trim().toLowerCase();
    const toName = nicknameByEmail[empEmailLower] || emp.input_name || '';

    const params = new URLSearchParams({
      secret: env.TREASURY_GAS_SECRET,
      type: effectiveType,
      toEmail: emp.matched_email || emp.input_email,
      toName: toName,
      monthLabel: reqRow.month_label,
      deadlineDate: body.deadlineDate || '',
      missingFields: effectiveType === 'optional_reminder' ? emp.missing_optional : emp.missing_mandatory
    });
    if (ccOverride) params.set('cc', ccOverride);

    let ok = true;
    try {
      const resp = await fetch(env.TREASURY_EMAIL_GAS_URL + '?' + params.toString());
      const respJson = await resp.json();
      ok = !!respJson.ok;
    } catch (e) { ok = false; }

    await env.DB.prepare(
      'INSERT INTO treasury_email_log (request_id, employee_email, email_type, sent_by, ok) VALUES (?, ?, ?, ?, ?)'
    ).bind(requestId, emp.matched_email || emp.input_email, effectiveType, actorEmail, ok ? 1 : 0).run();

    outcomes.push({ email: emp.matched_email || emp.input_email, ok });
  }

  await logAudit(env, actorEmail, 'emails_sent', { requestId, type: body.type, count: employees.length });
  return json({ ok: true, outcomes }, 200, origin);
}

// ------------------------------------------------------------
// Changelog: confronta i dati appena ricevuti dal GAS (bankRows/adjRows)
// contro treasury_field_snapshot in D1. Non legge MAI lo Sheet direttamente -
// i dati arrivano già pronti nel body della richiesta del GAS.
// ------------------------------------------------------------
const TRACKED_META_FIELDS = ['Status', 'Country'];

async function runDailyChangelogDiff(env, bankRows, adjRows, accessToken) {
  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  const { REQUIREMENTS, resolveCountry } = await import('./matching.js');

  const bankByEmail = {};
  bankRows.forEach((r) => {
    const e = String(r.Email || '').trim().toLowerCase();
    if (e) bankByEmail[e] = r;
  });

  const changesForSheetMirror = []; // righe pronte per il mirror, solo se accessToken disponibile

  for (const adjRow of adjRows) {
    const email = String(adjRow.Email || '').trim().toLowerCase();
    if (!email) continue;

    const country = resolveCountry(adjRow.Country);
    const bankRow = bankByEmail[email] || {};
    const bankFields = country && REQUIREMENTS[country]
      ? REQUIREMENTS[country].mandatory.concat(REQUIREMENTS[country].optional)
      : [];
    const metaSource = { Status: adjRow.Status, Country: adjRow.Country };
    const trackedFields = TRACKED_META_FIELDS.concat(bankFields);
    const name = [adjRow['First name'], adjRow['Last name']].filter(Boolean).join(' ');

    for (const field of trackedFields) {
      const isMeta = TRACKED_META_FIELDS.indexOf(field) !== -1;
      const sourceRow = isMeta ? metaSource : bankRow;
      const afterValue = sourceRow[field] !== undefined ? String(sourceRow[field]) : '';

      const snap = await env.DB.prepare(
        'SELECT value FROM treasury_field_snapshot WHERE email = ? AND field = ?'
      ).bind(email, field).first();

      const beforeValue = snap ? snap.value : null;
      if (beforeValue === null) {
        await env.DB.prepare(
          'INSERT INTO treasury_field_snapshot (email, field, value) VALUES (?, ?, ?)'
        ).bind(email, field, afterValue).run();
        continue;
      }

      if (beforeValue !== afterValue) {
        await env.DB.prepare(
          `INSERT INTO treasury_changelog (email, name, country, field, before_value, after_value, changed_date)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(email, name, country, field, beforeValue, afterValue, today).run();

        await env.DB.prepare(
          "UPDATE treasury_field_snapshot SET value = ?, updated_at = datetime('now') WHERE email = ? AND field = ?"
        ).bind(afterValue, email, field).run();

        changesForSheetMirror.push([email, name, country, field, beforeValue, afterValue, today, nowIso]);
      }
    }
  }

  // Mirror su Sheet, tab "Changelog" - solo se abbiamo un token (le chiamate
  // server-to-server dal Centrale lo passano sempre). Non bloccante: se
  // fallisce, il changelog resta comunque salvo su D1, che è la fonte vera.
  if (accessToken && changesForSheetMirror.length) {
    try {
      await appendSheetRows(
        accessToken, env.SHEET_ID, 'Changelog',
        ['Email', 'Name', 'Country', 'Field', 'Before', 'After', 'Changed Date', 'Detected At'],
        changesForSheetMirror
      );
    } catch (e) {
      console.error('[changelog sheet mirror]', e.message);
    }
  }
}
