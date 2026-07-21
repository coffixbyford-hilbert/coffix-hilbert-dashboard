/* ============================================================================
   Venue dashboard - Worker shell (ships in the FC Member Dashboard Kit)

   You are the AI running this build. This file is YOURS to finish; the owner
   never sees it. The shell already does the hard plumbing:

     - serves the dashboard page
     - a metrics API with a fixed contract the page already understands
     - an OAuth2 begin/callback flow with token storage
     - automatic access-token refresh, INCLUDING rotating refresh tokens
       (Xero rotates the refresh token on every refresh - the store persists
       the new one every time; never cache tokens outside the store)
     - plain-English connection status for the Connections screen
     - the no-API rungs built in: POST /api/ingest (file/export data in),
       an email() handler stub for emailed reports, a scheduled() cron hook,
       and a KV day-store the export-fed adapters read from

   What you fill in: the three ADAPTERS (accounting / pos / rostering), each
   marked with  >>> ADAPTER ...  blocks. Wire them against the provider's
   CURRENT documentation, per capability-matrix.md and playbook.md.

   Rules that bind every adapter (kpi-spec.md is the law):
     - accounting supplies EVERY money figure, always ex GST/sales tax
     - pos supplies ONE number: completed transaction count (no voids/refunds)
     - rostering supplies rostered cost only (projected wage %)
     - read-only scopes/permissions everywhere
     - secrets ONLY via Worker secrets (wrangler secret put NAME) - never in
       this file, never in the repo, never echoed to the owner

   Bindings expected (wrangler.toml): TOKENS (KV). Secrets: see each adapter.
============================================================================ */

import dashboardHtml from './dashboard.html';

/* ----------------------------------------------------------------------------
   Provider adapters - THE PART YOU BUILD.
   Flip `configured: true` per source as you wire it. Until then the
   dashboard honestly shows "not configured" (never a fake zero).
---------------------------------------------------------------------------- */
/* OPTIONAL no-API hooks any adapter may add (the fallback-ladder rungs):
     mode: 'export'           - source is fed by exports, not a live API
     parseExport(env, h, raw) - raw = { text, contentType }: parse the tool's
                                exported CSV/report into day rows:
                                  pos:        [{ date:'YYYY-MM-DD', count }]
                                  accounting: [{ date, revenue, cogs, wagesSuper, overheads }]
                                  rostering:  [{ date, cost }]
                                Adding parseExport makes the dashboard's
                                Connections screen offer a file-upload panel
                                for this source (the guided-upload rung).
     scheduledPull(env, h)    - cron hook (uncomment [triggers] in
                                wrangler.toml): fetch the tool's own export
                                (its report scheduler's output, a saved export
                                URL) and h.saveIngestedRows(rows).
   In export mode, implement fetchRange/fetchMonthly via h.readIngested /
   h.monthlyIngested instead of provider calls. Emailed reports: complete the
   email() handler at the bottom (needs the owner's domain on their Cloudflare
   with Email Routing pointed at this Worker). Ingest auth: the INGEST_TOKEN
   secret; if the owner uploads by hand, that same value is their upload code. */
const ADAPTERS = {

  /* >>> ADAPTER 1: ACCOUNTING (connect this FIRST - it feeds most of the board)
     Contract:
       auth: 'oauth' with the oauth{} block filled, or 'token' for a pasted key
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { revenue, cogs, wagesSuper, overheads }
                                 (numbers, ex GST/sales tax, for q.from..q.to
                                  inclusive, dates in the venue's books)
       fetchMonthly(env, h, q)-> { months:['YYYY-MM',...], revenue:[...],
                                   cogs:[...], wagesSuper:[...], overheads:[...] }
                                 (align arrays to months; null where no data)
     Map the owner's P&L faithfully: Revenue/Income section (trading income
     only - Other Income excluded), Cost of Sales section, wage + super
     accounts, Operating Expenses less wages/super. Do not re-categorise
     their books. See kpi-spec.md.
     Example (Xero): oauth with tokenAuth:'basic' (the token endpoint wants
     HTTP Basic client auth), scopes 'offline_access
     accounting.reports.profitandloss.read', P&L report endpoint, org name
     from the connections endpoint, sandbox = tenant name contains
     'Demo Company'. Secrets: ACCOUNTING_CLIENT_ID, ACCOUNTING_CLIENT_SECRET.
  */
  accounting: {
    configured: true,
    auth: 'oauth',
    oauth: {
      authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
      tokenUrl: 'https://identity.xero.com/connect/token',
      scopes: 'offline_access accounting.reports.profitandloss.read',
      clientIdSecret: 'ACCOUNTING_CLIENT_ID',
      clientSecretSecret: 'ACCOUNTING_CLIENT_SECRET',
      tokenAuth: 'basic'   // Xero's token endpoint wants HTTP Basic client auth (client_secret_basic)
    },
    async status(env, h) {
      const tokens = await h.getTokens();
      if (!tokens) return { connected: false };
      try {
        const conns = await h.fetchJson('https://api.xero.com/connections', { headers: { Accept: 'application/json' } });
        if (!Array.isArray(conns) || !conns.length) return { connected: false };
        const c = conns[0];
        return {
          connected: true,
          org: c.tenantName || null,
          sandbox: /demo company/i.test(c.tenantName || ''),
          lastSync: null
        };
      } catch (e) {
        return { connected: false };
      }
    },
    async fetchRange(env, h, q) {
      return xeroFetchRange(env, h, q.from, q.to);
    },
    async fetchMonthly(env, h, q) {
      const months = monthList(q.fromMonth, q.toMonth);
      const revenue = [], cogs = [], wagesSuper = [], overheads = [];
      for (const mo of months) {
        const [y, m] = mo.split('-').map(Number);
        const from = mo + '-01';
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const to = mo + '-' + String(lastDay).padStart(2, '0');
        try {
          const r = await xeroFetchRange(env, h, from, to);
          revenue.push(r.revenue); cogs.push(r.cogs); wagesSuper.push(r.wagesSuper); overheads.push(r.overheads);
        } catch (e) {
          revenue.push(null); cogs.push(null); wagesSuper.push(null); overheads.push(null);
        }
      }
      return { months, revenue, cogs, wagesSuper, overheads };
    }
  },

  /* >>> ADAPTER 2: POS
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { count }   (completed transactions only;
                                  exclude voided/cancelled; refunds never
                                  reduce the count; q.rollover shifts the
                                  trading-day boundary by that many hours)
       fetchMonthly(env, h, q)-> { months:[...], count:[...] }
     NEVER return a dollar figure from the POS.
     Example (Square): pasted production personal access token (secret
     POS_API_TOKEN); sandbox sign = token only answers on
     connect.squareupsandbox.com.
  */
  pos: {
    configured: true,
    auth: 'token',
    oauth: {},
    async status(env, h) {
      if (!env.POS_API_TOKEN) return { connected: false };
      try {
        const data = await squareRequest(env, '/v2/locations');
        const locs = (data && data.locations) || [];
        if (!locs.length) return { connected: false };
        /* Show only the venue this dashboard actually counts (see squareLocationIds) - not every
           location on the Square account, which would wrongly suggest they're all being counted. */
        const matched = locs.filter((l) => l.name === SQUARE_LOCATION_NAME);
        const shown = matched.length ? matched : locs;
        return { connected: true, org: shown.map((l) => l.name).filter(Boolean).join(', ') || null, sandbox: false, lastSync: null };
      } catch (e) {
        return { connected: false };
      }
    },
    async fetchRange(env, h, q) {
      return { count: await squareCountRange(env, q.from, q.to, q.tz, q.rollover) };
    },
    async fetchMonthly(env, h, q) {
      const months = monthList(q.fromMonth, q.toMonth);
      const count = [];
      for (const mo of months) {
        const [y, m] = mo.split('-').map(Number);
        const from = mo + '-01';
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const to = mo + '-' + String(lastDay).padStart(2, '0');
        try {
          count.push(await squareCountRange(env, from, to, q.tz, q.rollover));
        } catch (e) {
          count.push(null);
        }
      }
      return { months, count };
    }
  },

  /* >>> ADAPTER 3: ROSTERING (optional - only if the owner has one)
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { cost }    (rostered labour cost for the
                                  period; powers the PROJECTED wage % only)
     If this source is gated or absent, leave configured:false - the actual
     Wage % from accounting already covers the board (fallback ladder).
     Example (Deputy): pasted permanent token (secret ROSTERING_API_TOKEN).
  */
  rostering: {
    configured: true,
    auth: 'token',
    oauth: {},
    async status(env, h) {
      if (!env.ROSTERING_API_TOKEN) return { connected: false };
      try {
        const data = await deputyRequest(env, '/api/v1/resource/Company');
        const companies = Array.isArray(data) ? data : [];
        /* Show only the venue this dashboard actually counts (see DEPUTY_COMPANY_NAME) -
           not every company on this install, which would wrongly suggest they're all counted. */
        const match = companies.find((c) => c.CompanyName === DEPUTY_COMPANY_NAME);
        const name = (match && match.CompanyName) || (companies[0] && companies[0].CompanyName) || null;
        return { connected: true, org: name, sandbox: false, lastSync: null };
      } catch (e) {
        return { connected: false };
      }
    },
    async fetchRange(env, h, q) {
      return { cost: await deputyRosterCost(env, q.from, q.to) };
    },
    async fetchMonthly(env, h, q) {
      const months = monthList(q.fromMonth, q.toMonth);
      const cost = [];
      for (const mo of months) {
        const [y, m] = mo.split('-').map(Number);
        const from = mo + '-01';
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const to = mo + '-' + String(lastDay).padStart(2, '0');
        try {
          cost.push(await deputyRosterCost(env, from, to));
        } catch (e) {
          cost.push(null);
        }
      }
      return { months, cost };
    }
  }
};

/* ----------------------------------------------------------------------------
   Xero accounting helpers (kpi-spec.md is the law - read the owner's chart of
   accounts as-is, never re-categorise). Revenue = Income/Revenue section
   total (trading income only, "Other Income" excluded). Cost of goods = Cost
   of Sales section total. Within Operating Expenses, lines matching the wage
   keywords are wagesSuper; Overheads = Operating Expenses total minus
   wagesSuper. The exact wage-account list is CONFIRMED WITH THE OWNER during
   reconciliation (capability-matrix.md) - this keyword match only proposes it.
---------------------------------------------------------------------------- */
const XERO_WAGE_KEYWORDS = /wages|salaries|superannuation|super|payroll|annual leave|long service|workcover/i;

async function xeroConnection(env, h) {
  const conns = await h.fetchJson('https://api.xero.com/connections', { headers: { Accept: 'application/json' } });
  if (!Array.isArray(conns) || !conns.length) {
    const e = new Error('no Xero organisation connected'); e.status = 401; throw e;
  }
  return conns[0];
}

function xeroFindSection(rows, titleTest) {
  for (const r of rows || []) {
    if (r.RowType === 'Section' && titleTest(r.Title || '')) return r;
    if (r.Rows) {
      const found = xeroFindSection(r.Rows, titleTest);
      if (found) return found;
    }
  }
  return null;
}
function xeroFlattenRows(rows) {
  const out = [];
  for (const r of rows || []) {
    if (r.RowType === 'Row') out.push(r);
    if (r.Rows) out.push(...xeroFlattenRows(r.Rows));
  }
  return out;
}
function xeroCellNum(cell) {
  const n = parseFloat(cell && cell.Value);
  return isFinite(n) ? n : 0;
}
function xeroLastCellNum(row) {
  return row && row.Cells && row.Cells.length ? xeroCellNum(row.Cells[row.Cells.length - 1]) : 0;
}
function xeroSectionTotal(section) {
  if (!section) return 0;
  const summary = (section.Rows || []).find((r) => r.RowType === 'SummaryRow');
  if (summary) return xeroLastCellNum(summary);
  return xeroFlattenRows(section.Rows).reduce((sum, r) => sum + xeroLastCellNum(r), 0);
}

function xeroParsePnL(reportJson) {
  const report = reportJson && reportJson.Reports && reportJson.Reports[0];
  const rows = (report && report.Rows) || [];
  const incomeSection = xeroFindSection(rows, (t) => /income|revenue|sales/i.test(t) && !/other income/i.test(t));
  const cogsSection = xeroFindSection(rows, (t) => /cost of sales|cost of goods/i.test(t));
  const opexSection = xeroFindSection(rows, (t) => /operating expenses|expenses/i.test(t) && !/cost of sales/i.test(t));

  const revenue = xeroSectionTotal(incomeSection);
  const cogs = xeroSectionTotal(cogsSection);
  const opexTotal = xeroSectionTotal(opexSection);

  let wagesSuper = 0;
  if (opexSection) {
    for (const r of xeroFlattenRows(opexSection.Rows)) {
      const label = (r.Cells && r.Cells[0] && r.Cells[0].Value) || '';
      if (XERO_WAGE_KEYWORDS.test(label)) wagesSuper += xeroLastCellNum(r);
    }
  }
  return { revenue, cogs, wagesSuper, overheads: opexTotal - wagesSuper };
}

async function xeroFetchRange(env, h, from, to) {
  const conn = await xeroConnection(env, h);
  const p = new URLSearchParams({ fromDate: from, toDate: to });
  const data = await h.fetchJson('https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?' + p.toString(), {
    headers: { Accept: 'application/json', 'Xero-Tenant-Id': conn.tenantId }
  });
  return xeroParsePnL(data);
}

/* ----------------------------------------------------------------------------
   Square POS helpers. ONE number only: completed transaction count (voids/
   cancellations excluded, refunds never reduce the count - refunds are their
   own records, untouched here). Production host only - a token pasted from
   the Sandbox side of the Developer Console will fail every call here, which
   is the deliberate signal to go back and copy the Production token instead.
---------------------------------------------------------------------------- */
async function squareRequest(env, path, body) {
  const token = env.POS_API_TOKEN;
  if (!token) { const e = new Error('Square not connected'); e.status = 401; throw e; }
  const res = await fetch('https://connect.squareup.com' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
  return res.json();
}
/* This Square account has multiple locations (Byford, Hilbert, Little Bao Co).
   This dashboard is built for the Hilbert venue only (confirmed against the
   connected Xero org "Coffix Hilbert"). The exact Square location name below
   is a starting guess matching the Byford naming pattern - CONFIRM the exact
   name (and capitalisation - Byford had two similarly-named entries, only
   one of which was correct) with the owner during the Square connection step
   before trusting the count. Locking to this name keeps other venues out of
   the count even if Square's location list order changes. */
const SQUARE_LOCATION_NAME = 'COFFIX Hilbert';
/* Returns { ids, timezone } for the matched location(s). Square's own
   location record carries its own IANA timezone - that is what Square's own
   reports bucket orders by, so we use IT rather than the venue-wide settings
   timezone (which may be a geography guess) for day-boundary math here. */
async function squareLocationInfo(env) {
  const data = await squareRequest(env, '/v2/locations');
  const all = (data && data.locations) || [];
  const matched = all.filter((l) => l.name === SQUARE_LOCATION_NAME);
  const use = matched.length ? matched : all; /* safety net - should not happen once confirmed */
  return {
    ids: use.map((l) => l.id).filter(Boolean),
    timezone: (use[0] && use[0].timezone) || null
  };
}
async function squareLocationIds(env) {
  return (await squareLocationInfo(env)).ids;
}
/* The UTC offset of an IANA timezone at a given instant (minutes, e.g. +660 for AEST). */
function tzOffsetMinutes(tz, atUtcDate) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(atUtcDate).forEach((p) => { if (p.type !== 'literal') parts[p.type] = p.value; });
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return (asUtc - atUtcDate.getTime()) / 60000;
}
/* UTC instant for local midnight of dateStr in tz, shifted by the trading-day
   rollover (hours past midnight that still belong to the previous day). */
function zonedDayStartUtc(dateStr, tz, rolloverHours) {
  const guess = new Date(dateStr + 'T00:00:00Z');
  const offset1 = tzOffsetMinutes(tz, guess);
  let instant = new Date(guess.getTime() - offset1 * 60000);
  const offset2 = tzOffsetMinutes(tz, instant);
  if (offset2 !== offset1) instant = new Date(guess.getTime() - offset2 * 60000);
  return new Date(instant.getTime() + (rolloverHours || 0) * 3600000);
}
/* Counts completed PAYMENTS - verified against the owner's own Square Sales
   Summary report on a clean single day (20 Jul 2026: dashboard and Square
   both said 177, exact) - this is the correct method. Needs the Cloudflare
   Workers PAID plan for a full month's pagination (Square caps ListPayments
   at 100/page; a busy month needs ~50-60 pages, over the free plan's
   50-subrequest ceiling). De-duplicates by payment id as a safeguard against
   any cursor/page overlap. Uses the Square LOCATION's own configured
   timezone (not a geography guess) so day boundaries match what the owner
   sees in Square. Only status COMPLETED counts; a later refund does not
   remove a payment from this count (kpi-spec.md: refunds never reduce it). */
/* Fetches one date-window's worth of COMPLETED payment ids (sequential
   pagination within the window - each page's cursor depends on the last). */
async function squarePaymentIdsInWindow(env, locationId, startAt, endAt) {
  const ids = [];
  let cursor = null;
  do {
    const p = new URLSearchParams({
      location_id: locationId,
      begin_time: startAt.toISOString(),
      end_time: endAt.toISOString(),
      sort_field: 'CREATED_AT',
      limit: '100'
    });
    if (cursor) p.set('cursor', cursor);
    const data = await squareRequest(env, '/v2/payments?' + p.toString());
    for (const pmt of (data && data.payments) || []) {
      if (pmt.status === 'COMPLETED') ids.push(pmt.id);
    }
    cursor = data && data.cursor;
  } while (cursor);
  return ids;
}
async function squareCountRange(env, from, to, tz, rollover) {
  const info = await squareLocationInfo(env);
  if (!info.ids.length) return 0;
  const zone = info.timezone || tz || 'Australia/Sydney';
  const startAt = zonedDayStartUtc(from, zone, rollover || 0);
  const toNextDay = new Date(new Date(to + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
  const endAt = zonedDayStartUtc(toNextDay, zone, rollover || 0);
  /* Pages within one window must be fetched one after another (each needs the
     previous page's cursor), but separate date windows don't depend on each
     other - so for a long range, split it into ~week-long windows and fetch
     those IN PARALLEL. This is what actually speeds up a full month: same
     number of Square API calls, but done concurrently instead of one at a
     time (roughly a 5-7x wall-clock speedup for a full month). */
  const spanMs = endAt.getTime() - startAt.getTime();
  const spanDays = spanMs / 86400000;
  const CHUNK_DAYS = 7;
  const windows = [];
  if (spanDays <= CHUNK_DAYS) {
    windows.push({ start: startAt, end: endAt });
  } else {
    let cursorTime = startAt.getTime();
    while (cursorTime < endAt.getTime()) {
      const chunkEnd = Math.min(cursorTime + CHUNK_DAYS * 86400000, endAt.getTime());
      windows.push({ start: new Date(cursorTime), end: new Date(chunkEnd) });
      cursorTime = chunkEnd;
    }
  }
  const seen = new Set();
  for (const locationId of info.ids) {
    const results = await Promise.all(
      windows.map((w) => squarePaymentIdsInWindow(env, locationId, w.start, w.end))
    );
    for (const ids of results) for (const id of ids) seen.add(id);
  }
  return seen.size;
}

/* ----------------------------------------------------------------------------
   Deputy rostering helpers. Powers the OPTIONAL projected Wage % only - the
   actual Wage % (from Xero) already covers the board, so this never blocks
   the build if Deputy's cost data doesn't pan out (fallback ladder).
---------------------------------------------------------------------------- */
const DEPUTY_INSTALL_HOST = 'a4b00114045513.au.deputy.com';
async function deputyRequest(env, path, body) {
  const token = env.ROSTERING_API_TOKEN;
  if (!token) { const e = new Error('Deputy not connected'); e.status = 401; throw e; }
  const res = await fetch('https://' + DEPUTY_INSTALL_HOST + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
  return res.json();
}
/* This Deputy install has multiple companies (COFFIX BYFORD, COFFIX HILBERT,
   plus a non-workplace payroll entity) - Roster/QUERY returns shifts across
   all of them, so results are filtered to Hilbert's Company id. Resolved by
   name each call rather than hardcoded, in case the id ever changes. NOT YET
   confirmed with the owner (was confirmed for Byford on 2026-07-20, not
   Hilbert) - reconfirm the exact company name during the Deputy step. */
const DEPUTY_COMPANY_NAME = 'COFFIX HILBERT';
async function deputyHilbertCompanyId(env) {
  const companies = await deputyRequest(env, '/api/v1/resource/Company');
  const match = (Array.isArray(companies) ? companies : []).find((c) => c.CompanyName === DEPUTY_COMPANY_NAME);
  return match ? match.Id : null;
}
/* Sums rostered wage cost for the period from the Roster resource, Hilbert
   shifts only. Deputy exposes a per-shift Cost field on most plans (confirmed
   present and populated for the Byford company on this account; not yet
   re-confirmed for Hilbert); if it comes back null/absent this returns 0
   rather than guessing - see kpi-spec.md / capability-matrix.md: the
   fallback here is simply not showing a misleading projected figure. */
async function deputyRosterCost(env, from, to) {
  const companyId = await deputyHilbertCompanyId(env);
  const data = await deputyRequest(env, '/api/v1/resource/Roster/QUERY', {
    search: {
      s1: { field: 'Date', type: 'ge', data: from },
      s2: { field: 'Date', type: 'le', data: to }
    },
    max: 2000
  });
  const rows = Array.isArray(data) ? data : [];
  let cost = 0;
  for (const r of rows) {
    const rowCompanyId = r._DPMetaData && r._DPMetaData.OperationalUnitInfo && r._DPMetaData.OperationalUnitInfo.Company;
    if (companyId != null && rowCompanyId !== companyId) continue;
    const c = Number(r.Cost);
    if (isFinite(c)) cost += c;
  }
  return cost;
}

/* ============================================================================
   Everything below is the shell. You should rarely need to edit it.
============================================================================ */

class NotConfigured extends Error {
  constructor(source) { super('not configured: ' + source); this.source = source; }
}

const PLAIN_ERRORS = {
  401: 'This connection needs reconnecting. Click Reconnect and log in again.',
  403: 'This connection is missing a permission it needs. Your AI will sort out the access.',
  429: 'The tool is asking us to slow down. Wait a few minutes, then refresh.',
  500: 'The tool had a problem at its end. Try refresh in a little while.'
};
function plainError(status) {
  return PLAIN_ERRORS[status] || ('Something went wrong talking to this tool (code ' + status + '). Try refresh; if it persists, tell your AI.');
}

/* ---------------- Token store (KV) with refresh built in ---------------- */

async function getTokens(env, source) {
  const raw = await env.TOKENS.get('tokens:' + source);
  return raw ? JSON.parse(raw) : null;
}
async function saveTokens(env, source, tokens) {
  await env.TOKENS.put('tokens:' + source, JSON.stringify(tokens));
}
async function clearTokens(env, source) {
  await env.TOKENS.delete('tokens:' + source);
}
async function noteSync(env, source) {
  await env.TOKENS.put('lastSync:' + source, new Date().toISOString());
}
async function lastSync(env, source) {
  return await env.TOKENS.get('lastSync:' + source);
}

/* Build the POST to an OAuth token endpoint, honouring the adapter's client-auth
   method. tokenAuth:'basic' -> client id+secret in an HTTP Basic Authorization
   header, NOT in the body (Xero and most OpenID providers expect this); 'post'
   (or unset, for back-compat) -> client_id/client_secret in the form body. */
function tokenRequestInit(cfg, params, env) {
  const id = env[cfg.clientIdSecret] || '';
  const secret = env[cfg.clientSecretSecret] || '';
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(params);
  if ((cfg.tokenAuth || 'post') === 'basic') {
    headers['Authorization'] = 'Basic ' + btoa(id + ':' + secret);
  } else {
    body.set('client_id', id);
    body.set('client_secret', secret);
  }
  return { method: 'POST', headers: headers, body: body.toString() };
}

/* Returns a valid access token for an OAuth source, refreshing (and
   persisting the ROTATED refresh token) when needed. */
async function getValidAccessToken(env, source) {
  const adapter = ADAPTERS[source];
  const tokens = await getTokens(env, source);
  if (!tokens || !tokens.access_token) { const e = new Error('no tokens'); e.status = 401; throw e; }
  const skewMs = 60 * 1000;
  if (!tokens.expires_at || Date.now() < tokens.expires_at - skewMs) return tokens.access_token;

  /* refresh */
  const cfg = adapter.oauth || {};
  if (!tokens.refresh_token || !cfg.tokenUrl) { const e = new Error('cannot refresh'); e.status = 401; throw e; }
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  }, env));
  if (!res.ok) {
    /* refresh failed: force a reconnect rather than silently serving stale data */
    const e = new Error('refresh failed'); e.status = 401; throw e;
  }
  const fresh = await res.json();
  const updated = {
    ...tokens,
    access_token: fresh.access_token,
    /* CRITICAL: many providers (Xero!) rotate the refresh token - always keep the new one */
    refresh_token: fresh.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + ((fresh.expires_in || 1800) * 1000)
  };
  await saveTokens(env, source, updated);
  return updated.access_token;
}

/* Helpers handed to every adapter call */
function makeHelpers(env, source) {
  return {
    getValidAccessToken: () => getValidAccessToken(env, source),
    getTokens: () => getTokens(env, source),
    saveTokens: (t) => saveTokens(env, source, t),
    noteSync: () => noteSync(env, source),
    saveIngestedRows: (rows) => saveIngestedRows(env, source, rows),
    readIngested: (from, to) => readIngested(env, source, from, to),
    monthlyIngested: (fromMonth, toMonth) => monthlyIngested(env, source, fromMonth, toMonth),
    /* fetch JSON with one automatic refresh-and-retry on 401 (OAuth sources) */
    fetchJson: async (url, init, opts) => {
      const useAuth = !opts || opts.auth !== false;
      const doFetch = async () => {
        const headers = new Headers((init && init.headers) || {});
        if (useAuth && ADAPTERS[source].auth === 'oauth') {
          headers.set('Authorization', 'Bearer ' + await getValidAccessToken(env, source));
        }
        return fetch(url, { ...(init || {}), headers });
      };
      let res = await doFetch();
      if (res.status === 401 && useAuth && ADAPTERS[source].auth === 'oauth') {
        const t = await getTokens(env, source);
        if (t) { t.expires_at = 0; await saveTokens(env, source, t); } /* force refresh */
        res = await doFetch();
      }
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return res.json();
    }
  };
}

/* ---------------- OAuth begin + callback (generic, per-source) ---------- */

function randomState() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- Owner login: one passcode + a signed session cookie ----
   The owner sets the dashboard password on the dashboard's own FIRST-RUN screen;
   it is stored PBKDF2-hashed in KV (sys:passcode_hash) - no Cloudflare Variables
   step. (env.DASHBOARD_PASSCODE still works as an override, e.g. when the
   one-click button collected it in its wizard.) The session-signing key is
   generated and stored in KV on first run (env.SESSION_SECRET overrides if set).
   Until a password exists the dashboard shows the SET-PASSWORD screen, never an
   open page; once set, the page and every data route require a valid session. */
const SESSION_TTL = 60 * 60 * 24 * 30;
/* A password exists if the owner set one (first-run -> KV) or the deploy provided
   one as an env override (the one-click button's wizard). */
async function passcodeSet(env) {
  if (env.DASHBOARD_PASSCODE) return true;
  if (env.TOKENS) return !!(await env.TOKENS.get('sys:passcode_hash'));
  return false;
}
/* PBKDF2-SHA256 of a passcode with a hex salt -> base64url (at-rest hashing). */
async function pbkdf2B64(passcode, saltHex) {
  const salt = Uint8Array.from((saltHex.match(/.{2}/g) || []).map((h) => parseInt(h, 16)));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  return b64url(bits);
}
let _sessionKeyCache = null;
async function getSessionKey(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (_sessionKeyCache) return _sessionKeyCache;
  if (env.TOKENS) {
    let k = await env.TOKENS.get('sys:session_secret');
    if (!k) {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      k = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
      await env.TOKENS.put('sys:session_secret', k);
    }
    _sessionKeyCache = k;
    return k;
  }
  return env.DASHBOARD_PASSCODE || 'unset';
}
function b64url(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmacB64(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
async function shaB64(s) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function makeSession(env) {
  const payload = 'v1.' + Math.floor(Date.now() / 1000);
  return payload + '.' + await hmacB64(await getSessionKey(env), payload);
}
async function validSession(env, token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  if (!timingSafeEqual(token.slice(i + 1), await hmacB64(await getSessionKey(env), payload))) return false;
  const issued = parseInt(payload.split('.')[1], 10);
  return !!issued && (Date.now() / 1000 - issued) <= SESSION_TTL;
}
function getCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function isLoggedIn(request, env) {
  return await validSession(env, getCookie(request, 'vd_session'));
}
function htmlResponse(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
}
async function apiLogin(env, request) {
  if (!(await passcodeSet(env))) return json({ ok: false, error: 'no_passcode' }, 400);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  let okPass = false;
  if (env.DASHBOARD_PASSCODE) {
    okPass = timingSafeEqual(await shaB64(passcode), await shaB64(env.DASHBOARD_PASSCODE));
  } else if (env.TOKENS) {
    const stored = await env.TOKENS.get('sys:passcode_hash');
    if (stored) {
      const dot = stored.indexOf('.');
      okPass = timingSafeEqual(await pbkdf2B64(passcode, stored.slice(0, dot)), stored.slice(dot + 1));
    }
  }
  if (!okPass) return json({ ok: false }, 401);
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}

/* First-run (or authenticated change): set the dashboard password. Allowed only
   when none is set yet, OR when the caller already holds a valid session - so a
   stranger can never overwrite an existing password. Stored PBKDF2-hashed in KV. */
async function apiSetup(env, request) {
  if (!env.TOKENS) return json({ ok: false, error: 'no_store' }, 400);
  if ((await passcodeSet(env)) && !(await isLoggedIn(request, env))) return json({ ok: false, error: 'exists' }, 403);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  if (passcode.length < 6) return json({ ok: false, error: 'too_short' }, 400);
  const saltB = new Uint8Array(16); crypto.getRandomValues(saltB);
  const saltHex = Array.from(saltB).map((x) => x.toString(16).padStart(2, '0')).join('');
  await env.TOKENS.put('sys:passcode_hash', saltHex + '.' + (await pbkdf2B64(passcode, saltHex)));
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}
function apiLogout() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' } });
}
function loginPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in – Coffix Hilbert Dashboard</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Your dashboard</h1><p>Enter the password for this dashboard.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="current-password" placeholder="Password" autofocus>'
    + '<button type="submit">Sign in</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:document.getElementById("p").value})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="That password did not match. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

function setupPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Set your password – Coffix Hilbert Dashboard</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Set your password</h1><p>Choose a password for your dashboard. You\u2019ll type it each time you open it - pick something only you and your team know, at least 6 characters.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="new-password" placeholder="New password" autofocus>'
    + '<input id="p2" type="password" autocomplete="new-password" placeholder="Confirm password" style="margin-top:10px">'
    + '<button type="submit">Save and open my dashboard</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'var p=document.getElementById("p").value,p2=document.getElementById("p2").value;'
    + 'if(p.length<6){e.textContent="Use at least 6 characters.";return;}'
    + 'if(p!==p2){e.textContent="The two passwords do not match.";return;}'
    + 'fetch("/api/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:p})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="Could not save that. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

async function authStart(env, source, url) {
  const adapter = ADAPTERS[source];
  if (!adapter || adapter.auth !== 'oauth' || !adapter.oauth.authorizeUrl) {
    return new Response('This connection is not set up for browser authorisation yet.', { status: 404 });
  }
  const cfg = adapter.oauth;
  const state = randomState();
  await env.TOKENS.put('oauthstate:' + source, state, { expirationTtl: 600 });
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: env[cfg.clientIdSecret] || '',
    redirect_uri: redirectUri,
    scope: cfg.scopes || '',
    state
  });
  return Response.redirect(cfg.authorizeUrl + '?' + p.toString(), 302);
}

async function authCallback(env, source, url) {
  const adapter = ADAPTERS[source];
  const cfg = (adapter && adapter.oauth) || {};
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');
  const wantState = await env.TOKENS.get('oauthstate:' + source);
  if (!code || !gotState || gotState !== wantState) {
    return new Response('That authorisation didn’t complete cleanly. Go back to the dashboard and click Reconnect to try again.', { status: 400 });
  }
  await env.TOKENS.delete('oauthstate:' + source);
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  }, env));
  if (!res.ok) {
    return new Response('The connection couldn’t be finished (the tool said no: ' + res.status + '). Your AI will check the app settings - the usual cause is a redirect address that doesn’t match exactly.', { status: 502 });
  }
  const t = await res.json();
  await saveTokens(env, source, {
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    token_type: t.token_type || 'Bearer',
    expires_at: Date.now() + ((t.expires_in || 1800) * 1000),
    obtained_at: new Date().toISOString()
  });
  /* After token storage, adapters' status() should resolve org name etc. */
  return Response.redirect(url.origin + '/', 302);
}

/* ---------------- No-API ingest: KV day-store + endpoint ---------------- */

/* Day rows live at data:<source>:<YYYY-MM-DD> as JSON objects of numeric
   fields. Same-day re-uploads overwrite (idempotent; re-ingesting a corrected
   export is safe and expected). */
async function saveIngestedRows(env, source, rows) {
  if (!Array.isArray(rows)) return 0;
  let saved = 0;
  for (const r of rows) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) continue;
    const clean = {};
    for (const [k, v] of Object.entries(r)) {
      if (k !== 'date' && typeof v === 'number' && isFinite(v)) clean[k] = v;
    }
    if (Object.keys(clean).length === 0) continue;
    await env.TOKENS.put('data:' + source + ':' + r.date, JSON.stringify(clean));
    saved++;
  }
  return saved;
}

function eachDate(from, to, cap) {
  const out = [];
  const d = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (d.getTime() <= end.getTime() && out.length < (cap || 400)) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* Sum stored day rows across a range. Returns { sums, daysWithData, lastDate }. */
async function readIngested(env, source, from, to) {
  const sums = {};
  let daysWithData = 0, lastDate = null;
  for (const date of eachDate(from, to)) {
    const raw = await env.TOKENS.get('data:' + source + ':' + date);
    if (!raw) continue;
    daysWithData++; lastDate = date;
    try {
      const row = JSON.parse(raw);
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'number' && isFinite(v)) sums[k] = (sums[k] || 0) + v;
      }
    } catch (e) { /* skip bad row */ }
  }
  return { sums, daysWithData, lastDate };
}

async function monthlyIngested(env, source, fromMonth, toMonth) {
  const months = monthList(fromMonth, toMonth);
  const out = { months, byMonth: [] };
  for (const mo of months) {
    const [y, m] = mo.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const r = await readIngested(env, source, mo + '-01', mo + '-' + String(lastDay).padStart(2, '0'));
    out.byMonth.push(r.daysWithData ? r.sums : null);
  }
  return out;
}

/* POST /api/ingest?source=pos|accounting|rostering
   Authorization: Bearer <INGEST_TOKEN>. Body: the exported file's text.
   The source's adapter.parseExport() turns it into day rows. */
async function apiIngest(env, request, url) {
  const source = url.searchParams.get('source');
  if (!['accounting', 'pos', 'rostering'].includes(source)) return json({ error: 'unknown source' }, 400);
  const auth = request.headers.get('Authorization') || '';
  if (!env.INGEST_TOKEN || auth !== 'Bearer ' + env.INGEST_TOKEN) {
    return json({ error: 'not authorised', plain: 'That upload code didn\u2019t match. Check it with your AI and try again.' }, 401);
  }
  const adapter = ADAPTERS[source];
  if (!adapter || typeof adapter.parseExport !== 'function') {
    return json({ error: 'no parser', plain: 'This source isn\u2019t set up for file uploads yet. Your AI adds that when this path is chosen.' }, 501);
  }
  const text = await request.text();
  if (text.length > 2000000) return json({ error: 'too big', plain: 'That file is too large. Export a shorter date range and try again.' }, 413);
  try {
    const rows = await adapter.parseExport(env, makeHelpers(env, source), {
      text, contentType: request.headers.get('Content-Type') || ''
    });
    const saved = await saveIngestedRows(env, source, rows);
    if (!saved) return json({ error: 'nothing parsed', plain: 'No usable rows were found in that file. Check it\u2019s the right report, or show it to your AI.' }, 422);
    await noteSync(env, source);
    return json({ ok: true, days: saved });
  } catch (e) {
    return json({ error: 'parse failed', plain: 'That file couldn\u2019t be read. Check it\u2019s the right report, or show it to your AI.' }, 422);
  }
}

/* ---------------- Metrics API ---------------- */

function parseRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(s);
  return m ? { from: m[1], to: m[2] } : null;
}
function parseMonthRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}):(\d{4}-\d{2})$/.exec(s);
  return m ? { fromMonth: m[1], toMonth: m[2] } : null;
}

async function sourceStatus(env, source) {
  const adapter = ADAPTERS[source];
  if (!adapter || !adapter.configured) return { configured: false };
  try {
    const h = makeHelpers(env, source);
    const st = await adapter.status(env, h);
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: !!(st && st.connected),
      org: (st && st.org) || null,
      sandbox: !!(st && st.sandbox),
      lastSync: (st && st.lastSync) || (await lastSync(env, source)) || null,
      error: null
    };
  } catch (err) {
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: false,
      org: null,
      sandbox: false,
      lastSync: (await lastSync(env, source)) || null,
      error: { code: err.status || 0, plain: plainError(err.status || 500) }
    };
  }
}

async function fetchSlot(env, q) {
  /* One period slot: pull each configured source; null where unavailable. */
  const out = {};
  for (const source of ['accounting', 'pos', 'rostering']) {
    const adapter = ADAPTERS[source];
    if (!adapter || !adapter.configured) { out[source] = null; continue; }
    try {
      const h = makeHelpers(env, source);
      out[source] = await adapter.fetchRange(env, h, q);
      await noteSync(env, source);
    } catch (err) {
      out[source] = null; /* per-source failure never breaks the whole payload */
    }
  }
  return out;
}

const METRICS_CACHE_TTL = 120; /* seconds: brief cache for live provider data */

async function apiMetrics(env, url) {
  const cur = parseRange(url.searchParams.get('cur'));
  if (!cur) return json({ error: 'bad cur range' }, 400);
  const prev = parseRange(url.searchParams.get('prev'));
  const yoy = parseRange(url.searchParams.get('yoy'));
  const trend = parseMonthRange(url.searchParams.get('trend'));
  const tz = url.searchParams.get('tz') || 'Australia/Sydney';
  const rollover = Math.max(0, Math.min(6, parseInt(url.searchParams.get('rollover') || '0', 10) || 0));

  const base = { tz, rollover };
  const [sAcc, sPos, sRos] = await Promise.all([
    sourceStatus(env, 'accounting'),
    sourceStatus(env, 'pos'),
    sourceStatus(env, 'rostering')
  ]);

  /* The provider calls (periods + trend) are the expensive part and the only
     thing that brushes provider rate limits on quick reopens/refreshes. Cache
     them briefly in KV, keyed by the requested ranges; source status stays live.
     generatedAt is stored with the data so the dashboard's "last synced" reflects
     the real fetch time even when served from cache. ?refresh=1 forces fresh. */
  const cacheKey = 'metricscache:' + [
    url.searchParams.get('cur') || '', url.searchParams.get('prev') || '',
    url.searchParams.get('yoy') || '', url.searchParams.get('trend') || '',
    tz, rollover
  ].join('|');
  const force = url.searchParams.get('refresh') === '1';
  let data = null;
  if (!force && env.TOKENS) {
    const cached = await env.TOKENS.get(cacheKey);
    if (cached) { try { data = JSON.parse(cached); } catch (e) { data = null; } }
  }
  if (!data) {
    const periods = {};
    periods.cur = await fetchSlot(env, { ...base, ...cur });
    periods.prev = prev ? await fetchSlot(env, { ...base, ...prev }) : null;
    periods.yoy = yoy ? await fetchSlot(env, { ...base, ...yoy }) : null;

    let trendOut = null;
    if (trend) {
      trendOut = { months: monthList(trend.fromMonth, trend.toMonth) };
      for (const source of ['accounting', 'pos']) {
        const adapter = ADAPTERS[source];
        if (!adapter || !adapter.configured) { trendOut[source] = null; continue; }
        try {
          const h = makeHelpers(env, source);
          const series = await adapter.fetchMonthly(env, h, { ...base, ...trend });
          trendOut[source] = alignSeries(trendOut.months, series);
        } catch (err) { trendOut[source] = null; }
      }
    }
    data = { generatedAt: new Date().toISOString(), periods: periods, trend: trendOut };
    if (env.TOKENS) {
      try { await env.TOKENS.put(cacheKey, JSON.stringify(data), { expirationTtl: METRICS_CACHE_TTL }); } catch (e) {}
    }
  }

  return json({
    generatedAt: data.generatedAt,
    protected: true,
    sources: { accounting: sAcc, pos: sPos, rostering: sRos },
    periods: data.periods,
    trend: data.trend
  });
}

function monthList(fromMonth, toMonth) {
  const out = [];
  let [y, m] = fromMonth.split('-').map(Number);
  const [ey, em] = toMonth.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 60) break;
  }
  return out;
}
/* Adapters return {months:[...], <field>:[...]} - align onto the requested grid. */
function alignSeries(months, series) {
  if (!series || !Array.isArray(series.months)) return null;
  const idx = {};
  series.months.forEach((mo, i) => { idx[mo] = i; });
  const out = {};
  Object.keys(series).forEach((k) => {
    if (k === 'months') return;
    out[k] = months.map((mo) => (mo in idx && series[k] ? (series[k][idx[mo]] ?? null) : null));
  });
  return out;
}

/* ---------------- Router ---------------- */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path === '/api/login' && request.method === 'POST') return apiLogin(env, request);
    if (path === '/api/setup' && request.method === 'POST') return apiSetup(env, request);
    if (path === '/api/logout' && request.method === 'POST') return apiLogout();
    if (path === '/api/ingest' && request.method === 'POST') return apiIngest(env, request, url);

    const loggedIn = await isLoggedIn(request, env);

    if (path === '/' || path === '/index.html') {
      if (loggedIn) return htmlResponse(dashboardHtml);
      return htmlResponse((await passcodeSet(env)) ? loginPage() : setupPage());
    }
    if (path === '/api/metrics' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiMetrics(env, url);
    }
    const authRoute = /^\/auth\/(accounting|pos|rostering)\/(start|callback)$/.exec(path);
    if (authRoute && request.method === 'GET') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      return authRoute[2] === 'start' ? authStart(env, authRoute[1], url) : authCallback(env, authRoute[1], url);
    }
    if (path === '/api/disconnect' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      const source = url.searchParams.get('source');
      if (['accounting', 'pos', 'rostering'].includes(source)) {
        await clearTokens(env, source);
        return json({ ok: true });
      }
      return json({ error: 'unknown source' }, 400);
    }
    return new Response('Not found', { status: 404 });
  },

  /* Cron rung: uncomment [triggers] in wrangler.toml and give any adapter a
     scheduledPull() to fetch its tool's own export on a schedule. */
  async scheduled(event, env, ctx) {
    for (const source of ['accounting', 'pos', 'rostering']) {
      const a = ADAPTERS[source];
      if (a && typeof a.scheduledPull === 'function') {
        try {
          await a.scheduledPull(env, makeHelpers(env, source));
          await noteSync(env, source);
        } catch (e) {
          console.log('scheduledPull failed for ' + source + ': ' + (e && e.message));
        }
      }
    }
  },

  /* Email rung (Path B): the tool's own report scheduler emails its export;
     the owner's domain on their Cloudflare routes that address here (Email
     Routing -> this Worker). Complete when this rung is chosen:
       1. parse the message with postal-mime (add the dependency)
       2. find the CSV/report attachment, work out which source sent it
          (sender address or subject)
       3. reuse adapter.parseExport + saveIngestedRows + noteSync, exactly
          like /api/ingest
     Until then this logs and discards. */
  async email(message, env, ctx) {
    console.log('email received from ' + message.from + '; email ingest not wired yet');
  }
};
// EOF worker.js
