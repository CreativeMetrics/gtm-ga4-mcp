const { google } = require('googleapis');

function getSearchConsole(auth) {
  return google.searchconsole({ version: 'v1', auth });
}

async function listSites(auth) {
  const sc = getSearchConsole(auth);
  const res = await sc.sites.list();
  return res.data.siteEntry || [];
}

async function getSearchAnalytics(auth, siteUrl, { startDate, endDate, dimensions = ['query'], rowLimit = 25, dimensionFilterGroups } = {}) {
  const sc = getSearchConsole(auth);
  const body = { startDate, endDate, dimensions, rowLimit };
  if (dimensionFilterGroups) body.dimensionFilterGroups = dimensionFilterGroups;

  const res = await sc.searchanalytics.query({ siteUrl, requestBody: body });
  return {
    site: siteUrl,
    period: { start: startDate, end: endDate },
    rows: (res.data.rows || []).map(row => ({
      keys: row.keys,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: parseFloat((row.ctr * 100).toFixed(2)),
      position: parseFloat(row.position.toFixed(1)),
    })),
  };
}

async function getTopQueries(auth, siteUrl, days = 28, limit = 25) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days);
  const fmt = d => d.toISOString().slice(0, 10);
  return getSearchAnalytics(auth, siteUrl, {
    startDate: fmt(start),
    endDate: fmt(end),
    dimensions: ['query'],
    rowLimit: limit,
  });
}

async function getTopPages(auth, siteUrl, days = 28, limit = 25) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days);
  const fmt = d => d.toISOString().slice(0, 10);
  return getSearchAnalytics(auth, siteUrl, {
    startDate: fmt(start),
    endDate: fmt(end),
    dimensions: ['page'],
    rowLimit: limit,
  });
}

async function compareSearchPeriods(auth, siteUrl, days = 28) {
  const now = new Date();
  const fmt = d => d.toISOString().slice(0, 10);

  const endCurrent = new Date(now);
  const startCurrent = new Date(now);
  startCurrent.setDate(now.getDate() - days);

  const endPrev = new Date(startCurrent);
  endPrev.setDate(endPrev.getDate() - 1);
  const startPrev = new Date(endPrev);
  startPrev.setDate(endPrev.getDate() - days);

  const [current, previous] = await Promise.all([
    getSearchAnalytics(auth, siteUrl, { startDate: fmt(startCurrent), endDate: fmt(endCurrent), dimensions: ['query'], rowLimit: 50 }),
    getSearchAnalytics(auth, siteUrl, { startDate: fmt(startPrev), endDate: fmt(endPrev), dimensions: ['query'], rowLimit: 50 }),
  ]);

  const prevMap = {};
  for (const row of previous.rows) prevMap[row.keys[0]] = row;

  const comparison = current.rows.map(row => {
    const query = row.keys[0];
    const prev = prevMap[query];
    return {
      query,
      clicks_current: row.clicks,
      clicks_previous: prev?.clicks || 0,
      clicks_delta: row.clicks - (prev?.clicks || 0),
      position_current: row.position,
      position_previous: prev?.position || null,
    };
  }).sort((a, b) => b.clicks_current - a.clicks_current);

  return {
    site: siteUrl,
    current_period: `${fmt(startCurrent)} → ${fmt(endCurrent)}`,
    previous_period: `${fmt(startPrev)} → ${fmt(endPrev)}`,
    comparison,
  };
}

module.exports = { listSites, getSearchAnalytics, getTopQueries, getTopPages, compareSearchPeriods };
