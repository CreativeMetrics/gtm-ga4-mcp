const { google } = require('googleapis');

function getAnalyticsAdmin(auth) {
  return google.analyticsadmin({ version: 'v1beta', auth });
}

function getAnalyticsData(auth) {
  return google.analyticsdata({ version: 'v1beta', auth });
}

async function listProperties(auth) {
  const admin = getAnalyticsAdmin(auth);
  // accountSummaries returns all accounts + properties in one call, no account ID needed
  const res = await admin.accountSummaries.list({ pageSize: 200 });
  const summaries = res.data.accountSummaries || [];
  return summaries.flatMap(account =>
    (account.propertySummaries || []).map(p => ({
      name: p.property,
      displayName: p.displayName,
      account: account.account,
      accountDisplayName: account.displayName,
    }))
  );
}

async function listCustomDimensions(auth, propertyId) {
  const admin = getAnalyticsAdmin(auth);
  const res = await admin.properties.customDimensions.list({ parent: `properties/${propertyId}` });
  return res.data.customDimensions || [];
}

async function createCustomDimension(auth, propertyId, { displayName, parameterName, scope, description }) {
  const admin = getAnalyticsAdmin(auth);
  const res = await admin.properties.customDimensions.create({
    parent: `properties/${propertyId}`,
    requestBody: { displayName, parameterName, scope, description },
  });
  return res.data;
}

async function listCustomMetrics(auth, propertyId) {
  const admin = getAnalyticsAdmin(auth);
  const res = await admin.properties.customMetrics.list({ parent: `properties/${propertyId}` });
  return res.data.customMetrics || [];
}

async function runReport(auth, propertyId, { metrics, dimensions, dateRanges, limit = 10 }) {
  const data = getAnalyticsData(auth);
  const res = await data.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      metrics: metrics.map(m => ({ name: m })),
      dimensions: dimensions.map(d => ({ name: d })),
      dateRanges,
      limit,
    },
  });
  return res.data;
}

async function listConversionEvents(auth, propertyId) {
  const admin = getAnalyticsAdmin(auth);
  const res = await admin.properties.conversionEvents.list({ parent: `properties/${propertyId}` });
  return res.data.conversionEvents || [];
}

async function duplicateCustomDimensions(auth, sourcePropertyId, targetPropertyId) {
  const dims = await listCustomDimensions(auth, sourcePropertyId);
  const results = [];
  for (const dim of dims) {
    try {
      const created = await createCustomDimension(auth, targetPropertyId, {
        displayName: dim.displayName,
        parameterName: dim.parameterName,
        scope: dim.scope,
        description: dim.description || '',
      });
      results.push({ success: true, name: dim.displayName, data: created });
    } catch (err) {
      results.push({ success: false, name: dim.displayName, error: err.message });
    }
  }
  return results;
}

// ── NEW: Data Streams ─────────────────────────────────────────────────────────

async function listDataStreams(auth, propertyId) {
  const admin = getAnalyticsAdmin(auth);
  const res = await admin.properties.dataStreams.list({ parent: `properties/${propertyId}` });
  return res.data.dataStreams || [];
}

// ── NEW: Audiences ────────────────────────────────────────────────────────────

async function listAudiences(auth, propertyId) {
  const admin = getAnalyticsAdmin(auth);
  const res = await admin.properties.audiences.list({ parent: `properties/${propertyId}` });
  return res.data.audiences || [];
}

// ── NEW: Key Events (formerly Conversion Events) ──────────────────────────────

async function listKeyEvents(auth, propertyId) {
  const admin = getAnalyticsAdmin(auth);
  const res = await admin.properties.keyEvents.list({ parent: `properties/${propertyId}` });
  return res.data.keyEvents || [];
}

async function createKeyEvent(auth, propertyId, eventName) {
  const admin = getAnalyticsAdmin(auth);
  const res = await admin.properties.keyEvents.create({
    parent: `properties/${propertyId}`,
    requestBody: { eventName },
  });
  return res.data;
}

// ── NEW: Compare Properties ───────────────────────────────────────────────────

async function compareProperties(auth, propertyIdA, propertyIdB) {
  const [dimsA, dimsB, metricsA, metricsB, keyEventsA, keyEventsB, streamsA, streamsB] = await Promise.all([
    listCustomDimensions(auth, propertyIdA),
    listCustomDimensions(auth, propertyIdB),
    listCustomMetrics(auth, propertyIdA),
    listCustomMetrics(auth, propertyIdB),
    listKeyEvents(auth, propertyIdA),
    listKeyEvents(auth, propertyIdB),
    listDataStreams(auth, propertyIdA),
    listDataStreams(auth, propertyIdB),
  ]);

  const diff = (a, b, key) => {
    const setA = new Set(a.map(x => x[key]));
    const setB = new Set(b.map(x => x[key]));
    return {
      only_in_a: a.filter(x => !setB.has(x[key])).map(x => x[key]),
      only_in_b: b.filter(x => !setA.has(x[key])).map(x => x[key]),
      in_both: a.filter(x => setB.has(x[key])).map(x => x[key]),
    };
  };

  return {
    property_a: propertyIdA,
    property_b: propertyIdB,
    custom_dimensions: diff(dimsA, dimsB, 'parameterName'),
    custom_metrics: diff(metricsA, metricsB, 'parameterName'),
    key_events: diff(keyEventsA, keyEventsB, 'eventName'),
    data_streams: {
      count_a: streamsA.length,
      count_b: streamsB.length,
      streams_a: streamsA.map(s => ({ name: s.displayName, type: s.type, id: s.name })),
      streams_b: streamsB.map(s => ({ name: s.displayName, type: s.type, id: s.name })),
    },
  };
}

// ── NEW: Looker Studio report URL generator ───────────────────────────────────

const LOOKER_TEMPLATES = {
  ga4_overview:    'a52a4caa-d7af-4ec9-afc4-bce9e26f7ed5',
  ga4_acquisition: 'c6a42cfd-9be8-4e82-8c9b-e3e3f4f6d0fd',
  ga4_ecommerce:   '058e28c4-e8f7-421b-8d78-2e80ae44b7e5',
  ga4_engagement:  '854d0b24-8e85-4b40-9d13-8c8d3e7a9b21',
};

function generateLookerUrl(propertyId, templateKey) {
  const templateId = LOOKER_TEMPLATES[templateKey] || LOOKER_TEMPLATES.ga4_overview;
  const numericId = propertyId.replace('properties/', '');
  return `https://lookerstudio.google.com/reporting/create?c.reportId=${templateId}&ds.ga4.type=ANALYTICS&ds.ga4.propertyId=${numericId}`;
}

module.exports = {
  listProperties,
  listCustomDimensions,
  createCustomDimension,
  listCustomMetrics,
  runReport,
  listConversionEvents,
  duplicateCustomDimensions,
  listDataStreams,
  listAudiences,
  listKeyEvents,
  createKeyEvent,
  compareProperties,
  generateLookerUrl,
};
