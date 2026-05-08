#!/usr/bin/env node

/**
 * GTM & GA4 Health Check — standalone script per scheduling automatico
 * Legge la config da health-config.json, esegue il check e invia email se trova problemi.
 *
 * Scheduling: vedi health-check.plist (launchd macOS)
 * Config:     health-config.json
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const CREDENTIALS_PATH = path.join(process.env.HOME, '.gtm-ga4-mcp', 'credentials.json');
const TOKEN_PATH       = path.join(process.env.HOME, '.gtm-ga4-mcp', 'token.json');
const CONFIG_PATH      = path.join(__dirname, 'health-config.json');
const LOG_PATH         = path.join(__dirname, 'health-check.log');

// ── Auth ──────────────────────────────────────────────────────────────────────

function getAuth() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_secret, client_id } = credentials.installed || credentials.web;
  const auth = new google.auth.OAuth2(client_id, client_secret, 'urn:ietf:wg:oauth:2.0:oob');
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  auth.setCredentials(token);
  return auth;
}

// ── GA4 event counts ──────────────────────────────────────────────────────────

async function getEventCounts(auth, propertyId, startDate, endDate) {
  const data = google.analyticsdata({ version: 'v1beta', auth });
  const res = await data.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      metrics: [{ name: 'eventCount' }],
      dimensions: [{ name: 'eventName' }],
      dateRanges: [{ startDate, endDate }],
      limit: 200,
    },
  });
  const counts = {};
  for (const row of res.data.rows || []) {
    counts[row.dimensionValues[0].value] = parseInt(row.metricValues[0].value, 10);
  }
  return counts;
}

// ── GTM paused tags ───────────────────────────────────────────────────────────

async function getPausedTags(auth, accountId, containerId) {
  const gtm = google.tagmanager({ version: 'v2', auth });
  const wsRes = await gtm.accounts.containers.workspaces.list({
    parent: `accounts/${accountId}/containers/${containerId}`,
  });
  const workspaces = wsRes.data.workspace || [];
  const ws = workspaces.find(w => w.name === 'Default Workspace') || workspaces[0];
  if (!ws) return [];

  const tagsRes = await gtm.accounts.containers.workspaces.tags.list({
    parent: `accounts/${accountId}/containers/${containerId}/workspaces/${ws.workspaceId}`,
  });
  return (tagsRes.data.tag || []).filter(t => t.paused).map(t => t.name);
}

// ── Health check ──────────────────────────────────────────────────────────────

const MONITORED_EVENTS = [
  'page_view', 'session_start', 'first_visit',
  'purchase', 'add_to_cart', 'begin_checkout',
  'view_item', 'generate_lead', 'form_submit',
];

async function runCheck(auth, check, dropThreshold) {
  const issues = [];
  const healthy = [];

  const [current, previous, pausedTags] = await Promise.all([
    getEventCounts(auth, check.ga4_property_id, '7daysAgo', 'today'),
    getEventCounts(auth, check.ga4_property_id, '14daysAgo', '8daysAgo'),
    getPausedTags(auth, check.gtm_account_id, check.gtm_container_id),
  ]);

  for (const event of MONITORED_EVENTS) {
    const curr = current[event] || 0;
    const prev = previous[event] || 0;
    if (prev === 0 && curr === 0) continue;

    if (prev > 0 && curr === 0) {
      issues.push(`🔴 "${event}" si è fermato (era ${prev.toLocaleString('it-IT')} occorrenze)`);
    } else if (prev > 0 && curr < prev * (1 - dropThreshold)) {
      const drop = Math.round((1 - curr / prev) * 100);
      issues.push(`🟡 "${event}" calato del ${drop}% (${prev.toLocaleString('it-IT')} → ${curr.toLocaleString('it-IT')})`);
    } else if (curr > 0) {
      healthy.push(`✅ ${event}: ${curr.toLocaleString('it-IT')}`);
    }
  }

  if (pausedTags.length > 0) {
    issues.push(`⏸️ ${pausedTags.length} tag in pausa in GTM: ${pausedTags.join(', ')}`);
  }

  return { issues, healthy, label: check.label };
}

// ── Gmail send ────────────────────────────────────────────────────────────────

async function sendAlert(auth, to, subject, body) {
  const gmail = google.gmail({ version: 'v1', auth });
  const message = [
    `To: ${to}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    `Subject: ${subject}`,
    '',
    body,
  ].join('\n');

  const encoded = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
}

// ── Log ───────────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log('=== Health check avviato ===');

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const auth = getAuth();
  const dropThreshold = config.drop_threshold || 0.8;

  const allIssues = [];
  const lines = [`GTM & GA4 Health Report — ${new Date().toLocaleDateString('it-IT')}`, ''];

  for (const check of config.checks) {
    log(`Check: ${check.label} (GA4: ${check.ga4_property_id})`);
    try {
      const result = await runCheck(auth, check, dropThreshold);

      lines.push(`── ${result.label} ──`);
      if (result.issues.length === 0) {
        lines.push('✅ Tutto OK');
      } else {
        result.issues.forEach(i => lines.push(i));
        allIssues.push(...result.issues.map(i => `[${result.label}] ${i}`));
      }
      result.healthy.forEach(h => lines.push(h));
      lines.push('');

      log(`  Issues: ${result.issues.length}, OK: ${result.healthy.length}`);
    } catch (e) {
      const msg = `❌ Errore check "${check.label}": ${e.message}`;
      lines.push(msg);
      allIssues.push(msg);
      log(`  ERRORE: ${e.message}`);
    }
  }

  lines.push('— GTM & GA4 MCP Monitor');
  const body = lines.join('\n');

  if (allIssues.length > 0) {
    log(`Trovati ${allIssues.length} problemi — invio email a ${config.alert_email}`);
    try {
      await sendAlert(
        auth,
        config.alert_email,
        `⚠️ GTM/GA4 Alert — ${allIssues.length} problemi rilevati`,
        body
      );
      log('Email inviata');
    } catch (e) {
      log(`ERRORE invio email: ${e.message}`);
    }
  } else {
    log('Tutto OK — nessuna email inviata');
  }

  log('=== Health check completato ===\n');
}

main().catch(e => {
  const msg = `ERRORE CRITICO: ${e.message}`;
  console.error(msg);
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
  process.exit(1);
});
