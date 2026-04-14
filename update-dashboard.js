#!/usr/bin/env node

/**
 * Dashboard Auto-Update Script
 * Fetches fresh Clockify + Azure DevOps data for the previous completed month,
 * regenerates all data constants in clockify-dashboard.html, and pushes to GitHub.
 *
 * Required env vars:
 *   CLOCKIFY_API_KEY        — Clockify personal API key
 *   AZURE_PAT               — Azure DevOps personal access token (optional)
 *   AZURE_ORG               — Azure DevOps org name, e.g. "Fotopiatech" (optional)
 *
 * Optional env vars:
 *   CLOCKIFY_WORKSPACE_ID   — skip auto-detect and use this workspace
 *   AZURE_PROJECT           — ADO project name (default: all projects)
 *   TARGET_YEAR / TARGET_MONTH — override the month to fetch
 */

const fs    = require('fs');
const https = require('https');

// ── Configuration ────────────────────────────────────────────────────────────
const CLOCKIFY_API_KEY      = process.env.CLOCKIFY_API_KEY;
const CLOCKIFY_WORKSPACE_ID = process.env.CLOCKIFY_WORKSPACE_ID || null;
const AZURE_PAT             = process.env.AZURE_PAT  || null;
const AZURE_ORG             = process.env.AZURE_ORG  || null;
const AZURE_PROJECT         = process.env.AZURE_PROJECT || null;

if (!CLOCKIFY_API_KEY) {
  console.error('❌ CLOCKIFY_API_KEY is required');
  process.exit(1);
}

// Full-time member roster — must match Clockify display names exactly.
const FT_MEMBERS = new Set([
  'Yousef Eid', 'Nour Helal', 'Engy Ahmed', 'Deema',
  'Daniel Lewis', 'Omar Mohamed', 'Sameh Amnoun',
  'Aesha H.', 'Ijaz Ahmed', 'Muzamil S.', 'Farah Eid'
]);

// ── HTTP helper ──────────────────────────────────────────────────────────────
function httpRequest(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname, path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function clockify(path, method, body) {
  return httpRequest('api.clockify.me', '/api/v1' + path, method || 'GET',
    { 'X-Api-Key': CLOCKIFY_API_KEY }, body || null);
}

function clockifyReports(wsId, body) {
  return httpRequest('reports.api.clockify.me',
    `/v1/workspaces/${wsId}/reports/detailed`, 'POST',
    { 'X-Api-Key': CLOCKIFY_API_KEY }, body);
}

function adoGet(path) {
  if (!AZURE_PAT) return Promise.resolve({ status: 401, data: null });
  const token = Buffer.from(':' + AZURE_PAT).toString('base64');
  return httpRequest('dev.azure.com', path, 'GET',
    { 'Authorization': 'Basic ' + token, 'Accept': 'application/json' });
}

function adoPost(path, body) {
  if (!AZURE_PAT) return Promise.resolve({ status: 401, data: null });
  const token = Buffer.from(':' + AZURE_PAT).toString('base64');
  return httpRequest('dev.azure.com', path, 'POST',
    { 'Authorization': 'Basic ' + token, 'Accept': 'application/json' }, body);
}

// ── ISO duration → decimal hours ────────────────────────────────────────────
function parseDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
  if (!m) return 0;
  return (+(m[1] || 0)) + (+(m[2] || 0)) / 60 + (+(m[3] || 0)) / 3600;
}

// ── Work-type classifier ─────────────────────────────────────────────────────
function classifyWork(description, projectName) {
  const txt = ((description || '') + ' ' + (projectName || '')).toLowerCase();
  if (/\b(meeting|standup|stand-up|sync|demo|call|scrum|sprint review|retrospective|planning|1:1)\b/.test(txt))
    return 'Meeting';
  if (/\b(bug|fix|hotfix|defect|error|crash|patch|regression|incident)\b/.test(txt))
    return 'Bug Fix';
  if (/\b(feat(ure)?|new feature|implement|develop|story|epic|enhancement)\b/.test(txt))
    return 'Feature';
  if (/\b(support|cr\b|change request|assistance|rca|investigation)\b/.test(txt))
    return 'Support';
  return 'Unknown';
}

// ── Client detector ──────────────────────────────────────────────────────────
const CLIENT_PATTERNS = [
  { re: /fototrack|tracker|\bdet\b/i,  client: 'DET'        },
  { re: /\bkfh\b/i,                    client: 'KFH'        },
  { re: /\beneo\b/i,                   client: 'ENEO'       },
  { re: /\buaq\b/i,                    client: 'UAQ'        },
  { re: /\brta\b/i,                    client: 'RTA'        },
  { re: /digitize/i,                   client: 'Digitizeme' },
  { re: /\bdemo\b|demo support/i,      client: 'Internal'   },
];
function detectClient(projectName, description) {
  const txt = (projectName || '') + ' ' + (description || '');
  for (const { re, client } of CLIENT_PATTERNS) {
    if (re.test(txt)) return client;
  }
  return 'Fotopia';
}

// ── Product-group mapper ─────────────────────────────────────────────────────
const PRODUCT_GROUPS = [
  { re: /fotognize|foto gnize/i,       group: 'Fotognize'       },
  { re: /fotocapture|foto capture/i,   group: 'Capture'         },
  { re: /fotofind|foto find/i,         group: 'Fotofind'        },
  { re: /fototrack|fototracker/i,      group: 'Fototracker'     },
  { re: /fotoscan/i,                   group: 'Other'           },
  { re: /fotoverifai/i,                group: 'Fotoverifai'     },
  { re: /ctc/i,                        group: 'CTC Application' },
  { re: /r&d|research/i,               group: 'Internal'        },
  { re: /demo/i,                       group: 'Demos'           },
];
function productGroup(projectName) {
  for (const { re, group } of PRODUCT_GROUPS) {
    if (re.test(projectName || '')) return group;
  }
  return 'Internal';
}

// ── Date range helpers ───────────────────────────────────────────────────────
function monthRange(year, month) {
  const pad      = n => String(n).padStart(2, '0');
  const lastDay  = new Date(year, month, 0).getDate();
  const monthName= new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long' });
  const shortMon = new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'short' });
  return {
    start:       `${year}-${pad(month)}-01T00:00:00.000Z`,
    end:         `${year}-${pad(month)}-${pad(lastDay)}T23:59:59.999Z`,
    startIso:    `${year}-${pad(month)}-01`,
    endIso:      `${year}-${pad(month)}-${pad(lastDay)}`,
    label:       `${monthName} ${year}`,
    shortLabel:  shortMon,
    daysInMonth: lastDay,
    year, month
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function updateDashboard() {
  console.log('🔄 Starting dashboard update…');

  // Determine target month (default: previous completed month)
  const now    = new Date();
  let tYear    = parseInt(process.env.TARGET_YEAR  || now.getFullYear());
  let tMonth   = parseInt(process.env.TARGET_MONTH || (() => {
    // Switch to current month after the 3rd (data typically settles by then)
    return now.getDate() <= 3 ? now.getMonth() : now.getMonth() + 1;
  })());
  if (tMonth < 1)  { tMonth = 12; tYear--; }
  if (tMonth > 12) { tMonth = 1;  tYear++; }
  const range = monthRange(tYear, tMonth);
  console.log(`📅 Target: ${range.label}`);

  // Load vacation days
  let vacDays = {};
  if (fs.existsSync('vacation-days.json')) {
    vacDays = JSON.parse(fs.readFileSync('vacation-days.json', 'utf8'));
    console.log('✅ Loaded vacation-days.json');
  }

  // Resolve workspace
  const wsId = CLOCKIFY_WORKSPACE_ID || await getWorkspaceId();
  console.log(`🏢 Workspace: ${wsId}`);

  // Fetch Clockify data
  const clockData = await fetchClockifyData(wsId, range);
  console.log(`✅ ${clockData.entryCount} entries · ${Object.keys(clockData.users).length} members`);

  // Fetch Azure DevOps (optional)
  let attribution = null;
  if (AZURE_PAT && AZURE_ORG) {
    attribution = await fetchDevOpsData(range);
    console.log(`✅ DevOps: ${Object.keys(attribution).length} members`);
  } else {
    console.log('ℹ️  Skipping DevOps (AZURE_PAT/AZURE_ORG not set)');
  }

  // Patch HTML
  const html    = fs.readFileSync('clockify-dashboard.html', 'utf8');
  const patched = patchHtml(html, clockData, attribution, vacDays, range);
  fs.writeFileSync('clockify-dashboard.html', patched);
  console.log('✅ clockify-dashboard.html updated');

  await gitCommitAndPush(range.label);
  console.log('🎉 Done!');
}

// ── Get first workspace ID ───────────────────────────────────────────────────
async function getWorkspaceId() {
  const r = await clockify('/workspaces');
  if (r.status !== 200 || !Array.isArray(r.data) || !r.data.length) {
    console.error('❌ Could not list workspaces:', r.status, JSON.stringify(r.data || '').slice(0, 200));
    process.exit(1);
  }
  console.log(`  Workspaces: ${r.data.map(w => w.name).join(', ')}`);
  return r.data[0].id;
}

// ── Fetch all time entries (paginated) ───────────────────────────────────────
async function fetchAllTimeEntries(wsId, range) {
  const all     = [];
  const PAGE_SZ = 1000;
  let   page    = 1;
  while (true) {
    const r = await clockifyReports(wsId, {
      dateRangeStart: range.start,
      dateRangeEnd:   range.end,
      detailedFilter: { page, pageSize: PAGE_SZ, sortColumn: 'DATE' }
    });
    if (r.status !== 200) {
      console.error(`  ⚠️  Reports API ${r.status} on page ${page}`);
      break;
    }
    const batch = r.data.timeentries || [];
    console.log(`  → page ${page}: ${batch.length} entries`);
    all.push(...batch);
    if (batch.length < PAGE_SZ) break;
    page++;
  }
  return all;
}

// ── Aggregate entries into dashboard data ────────────────────────────────────
async function fetchClockifyData(wsId, range) {
  console.log('📡 Fetching Clockify time entries…');
  const entries = await fetchAllTimeEntries(wsId, range);

  const users     = {};
  const daily     = {};
  const products  = {};
  const clients   = {};
  const workTypes = {};

  // Pre-fill every day so the daily chart has no gaps
  for (let d = 1; d <= range.daysInMonth; d++) {
    daily[`${range.shortLabel} ${d}`] = { dev: 0, mtg: 0 };
  }

  for (const entry of entries) {
    const name    = entry.userName    || 'Unknown';
    const project = entry.projectName || 'Unassigned';
    const desc    = entry.description || '';
    const hrs     = parseDuration(entry.timeInterval && entry.timeInterval.duration);
    if (hrs <= 0) continue;

    const wt     = classifyWork(desc, project);
    const isMtg  = wt === 'Meeting';
    const client = detectClient(project, desc);
    const grp    = productGroup(project);
    const start  = entry.timeInterval && entry.timeInterval.start;
    const d      = start ? new Date(start) : new Date();
    const dayLbl = `${range.shortLabel} ${d.getUTCDate()}`;

    // Per-user
    if (!users[name]) {
      users[name] = { dev:0, mtg:0, total:0, full: FT_MEMBERS.has(name), c:{}, p:{}, w:{} };
    }
    const u = users[name];
    if (isMtg) u.mtg += hrs; else u.dev += hrs;
    u.total       += hrs;
    u.c[client]    = (u.c[client]  || 0) + hrs;
    u.p[project]   = (u.p[project] || 0) + hrs;
    u.w[wt]        = (u.w[wt]      || 0) + hrs;

    // Daily
    if (daily[dayLbl]) {
      if (isMtg) daily[dayLbl].mtg += hrs;
      else       daily[dayLbl].dev += hrs;
    }

    // Products
    if (!products[project]) products[project] = { dev:0, mtg:0, total:0, group: grp };
    if (isMtg) products[project].mtg += hrs; else products[project].dev += hrs;
    products[project].total += hrs;

    // Clients
    if (!clients[client]) clients[client] = { dev:0, mtg:0, total:0 };
    if (isMtg) clients[client].mtg += hrs; else clients[client].dev += hrs;
    clients[client].total += hrs;

    // Work types
    if (!workTypes[wt]) workTypes[wt] = { hrs:0, count:0 };
    workTypes[wt].hrs   += hrs;
    workTypes[wt].count += 1;
  }

  // Round to 2 dp
  const r2 = v => Math.round(v * 100) / 100;
  for (const u of Object.values(users)) {
    u.dev=r2(u.dev); u.mtg=r2(u.mtg); u.total=r2(u.total);
    for (const k in u.c) u.c[k]=r2(u.c[k]);
    for (const k in u.p) u.p[k]=r2(u.p[k]);
    for (const k in u.w) u.w[k]=r2(u.w[k]);
  }
  for (const p of Object.values(products))  { p.dev=r2(p.dev); p.mtg=r2(p.mtg); p.total=r2(p.total); }
  for (const c of Object.values(clients))   { c.dev=r2(c.dev); c.mtg=r2(c.mtg); c.total=r2(c.total); }
  for (const w of Object.values(workTypes)) { w.hrs=r2(w.hrs); }

  const dailyArray = Object.entries(daily).map(([d, v]) => ({ d, dev: r2(v.dev), mtg: r2(v.mtg) }));

  return { users, dailyArray, products, clients, workTypes, entryCount: entries.length };
}

// ── Azure DevOps data ────────────────────────────────────────────────────────
async function fetchDevOpsData(range) {
  console.log('🔧 Fetching Azure DevOps data…');
  const attribution = {};
  const org  = AZURE_ORG;
  const proj = AZURE_PROJECT || '';
  const seg  = proj ? `${org}/${proj}` : org;

  function ensure(name) {
    if (!attribution[name]) attribution[name] = {
      dn: name, total:0, qaFlow:0, inferred:0,
      byType:{}, cx:{Low:0,Medium:0,High:0}, bySV:{},
      cycleTime: null,
      prs: { authored:0, reviewed:0, approved:0, merged:0, reopened:0, noLinkedPR:0 },
      dataSource: 'live'
    };
    return attribution[name];
  }

  try {
    // Work items closed this month
    const wiqlRes = await adoPost(`/${seg}/_apis/wit/wiql?api-version=7.0`, {
      query: `SELECT [System.Id] FROM WorkItems
              WHERE [System.State] = 'Closed'
                AND [Microsoft.VSTS.Common.ClosedDate] >= '${range.startIso}'
                AND [Microsoft.VSTS.Common.ClosedDate] <= '${range.endIso}'`
    });
    const ids = ((wiqlRes.data && wiqlRes.data.workItems) || []).map(w => w.id).slice(0, 200);
    if (ids.length > 0) {
      const fields = 'System.AssignedTo,System.WorkItemType,System.AreaPath';
      const dr = await adoGet(`/${seg}/_apis/wit/workitems?ids=${ids.join(',')}&fields=${fields}&api-version=7.0`);
      for (const wi of ((dr.data && dr.data.value) || [])) {
        const name = (wi.fields && wi.fields['System.AssignedTo'] && wi.fields['System.AssignedTo'].displayName) || 'Unknown';
        const type = (wi.fields && wi.fields['System.WorkItemType']) || 'Task';
        const area = ((wi.fields && wi.fields['System.AreaPath']) || '').split('\\').pop();
        const m = ensure(name);
        m.total += 1;
        m.byType[type] = (m.byType[type] || 0) + 1;
        if (area) m.bySV[area] = (m.bySV[area] || 0) + 1;
        if      (type === 'Bug')                         m.cx.High   += 1;
        else if (type === 'Feature' || type === 'User Story') m.cx.Medium += 1;
        else                                             m.cx.Low    += 1;
      }
    }
    console.log(`  ✅ ${ids.length} closed work items`);

    // Pull requests merged this month
    const reposRes = await adoGet(`/${seg}/_apis/git/repositories?api-version=7.0`);
    let prCount = 0;
    for (const repo of ((reposRes.data && reposRes.data.value) || [])) {
      const prsRes = await adoGet(
        `/${seg}/_apis/git/repositories/${repo.id}/pullrequests`
        + `?searchCriteria.status=completed`
        + `&searchCriteria.minTime=${range.startIso}`
        + `&searchCriteria.maxTime=${range.endIso}`
        + `&$top=100&api-version=7.0`
      );
      for (const pr of ((prsRes.data && prsRes.data.value) || [])) {
        const author = (pr.createdBy && pr.createdBy.displayName) || 'Unknown';
        const mA = ensure(author);
        mA.prs.authored += 1;
        mA.prs.merged   += 1;
        for (const rev of (pr.reviewers || [])) {
          if (rev.vote >= 10) {
            const mR = ensure(rev.displayName || 'Unknown');
            mR.prs.reviewed += 1;
            mR.prs.approved += 1;
          }
        }
        prCount++;
      }
    }
    console.log(`  ✅ ${prCount} merged pull requests`);
  } catch (e) {
    console.log(`  ⚠️  DevOps partial error: ${e.message}`);
  }

  return attribution;
}

// ── Patch HTML data constants ────────────────────────────────────────────────
function patchHtml(html, clockData, attribution, vacDays, range) {
  let h = html;

  function replaceConst(name, value) {
    // Match: const NAME = <multiline value>;
    const re = new RegExp(`(const ${name}\\s*=\\s*)[\\s\\S]*?(?=;\\s*\\n)`, 'm');
    if (!re.test(h)) { console.log(`  ⚠️  const ${name} not found`); return; }
    h = h.replace(re, `$1${JSON.stringify(value, null, 2)}`);
    console.log(`  ✅ const ${name} replaced`);
  }

  if (clockData.entryCount > 0) {
    replaceConst('USERS',         clockData.users);
    replaceConst('dailyData',     clockData.dailyArray);
    replaceConst('productStats',  clockData.products);
    replaceConst('clientStats',   clockData.clients);
    replaceConst('workTypeStats', clockData.workTypes);
  } else {
    console.log('  ⚠️  0 entries — data constants unchanged');
  }

  if (attribution && Object.keys(attribution).length > 0) {
    replaceConst('ATTRIBUTION', attribution);
  }

  // Date boundaries for JS filter
  h = h.replace(/const DASH_START\s*=\s*'[^']*'/, `const DASH_START = '${range.startIso}'`);
  h = h.replace(/const DASH_END\s*=\s*'[^']*'/,   `const DASH_END   = '${range.endIso}'`);

  // Date input attributes (value, min, max) — update each attribute independently
  ['dateFrom', 'dateTo'].forEach(id => {
    const newVal = id === 'dateFrom' ? range.startIso : range.endIso;
    const re = new RegExp(`(<input[^>]+id="${id}"[^>]*?)value="[^"]*"`, 'g');
    h = h.replace(re, `$1value="${newVal}"`);
    const reMin = new RegExp(`(<input[^>]+id="${id}"[^>]*?)min="[^"]*"`, 'g');
    h = h.replace(reMin, `$1min="${range.startIso}"`);
    const reMax = new RegExp(`(<input[^>]+id="${id}"[^>]*?)max="[^"]*"`, 'g');
    h = h.replace(reMax, `$1max="${range.endIso}"`);
  });

  // Page title + badge
  h = h.replace(/<title>[^<]*<\/title>/, `<title>Team Time Dashboard – ${range.label}</title>`);
  h = h.replace(/<span class="badge">[^<]*<\/span>/, `<span class="badge">${range.label}</span>`);

  // Header subtitle
  const memberCount = Object.keys(clockData.users).length;
  const today = new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric' });
  h = h.replace(
    /(<div class="h2">)[^<]*(<\/div>)/,
    `$1Nourhan Hosny's Workspace · ${memberCount} members · ${clockData.entryCount} entries · Updated ${today}$2`
  );

  // Vacation days
  const vacConst = `const _vacSettings = ${JSON.stringify(vacDays, null, 2)};`;
  if (h.includes('const _vacSettings')) {
    h = h.replace(/const _vacSettings\s*=[\s\S]*?;(?=\s*\n)/, vacConst);
  } else {
    h = h.replace('</script>', `\n// ── Persistent vacation days ──\n${vacConst}\n</script>`);
  }

  return h;
}

// ── Git commit & push ────────────────────────────────────────────────────────
async function gitCommitAndPush(label) {
  const { execSync } = require('child_process');
  try {
    execSync('git config user.name  "Dashboard Auto-Update"');
    execSync('git config user.email "action@github.com"');
    execSync('git add clockify-dashboard.html vacation-days.json');
    const msg = `🔄 Auto-update: ${label} data (${new Date().toISOString().slice(0, 10)})`;
    execSync(`git diff --cached --quiet || git commit -m "${msg}"`);
    execSync('git push origin main');
    console.log('✅ Pushed');
  } catch (e) {
    console.log('ℹ️  Git skipped:', e.message.slice(0, 120));
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────
updateDashboard().catch(e => { console.error('❌ Fatal:', e); process.exit(1); });
