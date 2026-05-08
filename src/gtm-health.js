const { google } = require('googleapis');

// Maps GTM tag types to the GA4 event names they typically send
const GTM_TYPE_TO_GA4_EVENT = {
  googtag:      null,   // Google Tag itself — check via sessions/pageviews
  ua:           null,   // Universal Analytics — deprecated
  awct:         'conversion',
  'html':       null,   // Custom HTML — can't know the event name
};

// GA4 event names that signal common tag types are firing
const IMPORTANT_EVENTS = [
  'page_view',
  'session_start',
  'first_visit',
  'purchase',
  'add_to_cart',
  'begin_checkout',
  'view_item',
  'generate_lead',
  'form_submit',
  'click',
];

function getGtm(auth) {
  return google.tagmanager({ version: 'v2', auth });
}

function getAnalyticsData(auth) {
  return google.analyticsdata({ version: 'v1beta', auth });
}

async function runEventReport(analyticsData, propertyId, startDate, endDate) {
  const res = await analyticsData.properties.runReport({
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

async function checkTagHealth(auth, gtmAccountId, gtmContainerId, ga4PropertyId, options = {}) {
  const gtm = getGtm(auth);
  const analyticsData = getAnalyticsData(auth);
  const dropThreshold = options.dropThreshold || 0.8; // alert if >80% drop
  const issues = [];
  const healthy = [];

  // 1. Get GA4 event counts: last 7 days vs previous 7 days
  const [current, previous] = await Promise.all([
    runEventReport(analyticsData, ga4PropertyId, '7daysAgo', 'today'),
    runEventReport(analyticsData, ga4PropertyId, '14daysAgo', '8daysAgo'),
  ]);

  // 2. Check core GA4 events (page_view, session_start etc.)
  for (const eventName of IMPORTANT_EVENTS) {
    const curr = current[eventName] || 0;
    const prev = previous[eventName] || 0;
    if (prev === 0 && curr === 0) continue; // never fired, skip

    if (prev > 0 && curr === 0) {
      issues.push({
        type: 'stopped',
        event: eventName,
        current_7d: curr,
        previous_7d: prev,
        message: `Evento "${eventName}" era attivo (${prev} occorrenze) ma non sta più sparando`,
      });
    } else if (prev > 0 && curr < prev * (1 - dropThreshold)) {
      const drop = Math.round((1 - curr / prev) * 100);
      issues.push({
        type: 'drop',
        event: eventName,
        current_7d: curr,
        previous_7d: prev,
        drop_pct: drop,
        message: `Evento "${eventName}" calato del ${drop}% (${prev} → ${curr})`,
      });
    } else if (curr > 0) {
      healthy.push({ event: eventName, current_7d: curr, previous_7d: prev });
    }
  }

  // 3. List GTM tags and flag paused or tagless containers
  const wsRes = await gtm.accounts.containers.workspaces.list({
    parent: `accounts/${gtmAccountId}/containers/${gtmContainerId}`,
  });
  const workspaces = wsRes.data.workspace || [];
  const defaultWs = workspaces.find(w => w.name === 'Default Workspace') || workspaces[0];

  let pausedTags = [];
  if (defaultWs) {
    const tagsRes = await gtm.accounts.containers.workspaces.tags.list({
      parent: `accounts/${gtmAccountId}/containers/${gtmContainerId}/workspaces/${defaultWs.workspaceId}`,
    });
    pausedTags = (tagsRes.data.tag || []).filter(t => t.paused);
    if (pausedTags.length > 0) {
      issues.push({
        type: 'paused_tags',
        count: pausedTags.length,
        tags: pausedTags.map(t => t.name),
        message: `${pausedTags.length} tag in pausa in GTM: ${pausedTags.map(t => t.name).join(', ')}`,
      });
    }
  }

  return {
    ga4_property: ga4PropertyId,
    gtm_container: gtmContainerId,
    period: { current: 'ultimi 7 giorni', previous: '7 giorni precedenti' },
    status: issues.length === 0 ? 'ok' : 'issues_found',
    issues,
    healthy_events: healthy,
    paused_tags_count: pausedTags.length,
    summary: issues.length === 0
      ? 'Tutti gli eventi monitorati sono nella norma.'
      : `Trovati ${issues.length} problemi: ${issues.map(i => i.message).join(' | ')}`,
  };
}

// Formats the health check result as a readable email body
function formatHealthReport(result, siteUrl) {
  const lines = [];
  lines.push(`GTM & GA4 Health Report — ${siteUrl || result.gtm_container}`);
  lines.push(`Data: ${new Date().toLocaleDateString('it-IT')}`);
  lines.push('');

  if (result.status === 'ok') {
    lines.push('✅ Tutto OK — nessun problema rilevato.');
  } else {
    lines.push(`⚠️ Trovati ${result.issues.length} problemi:`);
    lines.push('');
    for (const issue of result.issues) {
      lines.push(`• ${issue.message}`);
    }
  }

  lines.push('');
  lines.push(`Eventi sani (ultimi 7 giorni):`);
  for (const e of result.healthy_events) {
    lines.push(`  ✓ ${e.event}: ${e.current_7d.toLocaleString()} occorrenze`);
  }

  lines.push('');
  lines.push('— GTM & GA4 MCP Monitor');
  return lines.join('\n');
}

module.exports = { checkTagHealth, formatHealthReport };
