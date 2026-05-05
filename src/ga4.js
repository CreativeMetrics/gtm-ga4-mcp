const { google } = require('googleapis');

function getAnalyticsAdmin(auth) {
  return google.analyticsadmin({ version: 'v1beta', auth });
}

function getAnalyticsData(auth) {
  return google.analyticsdata({ version: 'v1beta', auth });
}

async function listProperties(auth) {
  const admin = getAnalyticsAdmin(auth);
  const res = await admin.properties.list({ filter: 'parent:accounts/-' });
  return res.data.properties || [];
}

async function listCustomDimensions(auth, propertyId) {
  const admin = getAnalyticsAdmin(auth);
  const res = await admin.properties.customDimensions.list({
    parent: `properties/${propertyId}`,
  });
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
  const res = await admin.properties.customMetrics.list({
    parent: `properties/${propertyId}`,
  });
  return res.data.customMetrics || [];
}

async function runReport(auth, propertyId, { metrics, dimensions, dateRanges, limit = 10 }) {
  const data = getAnalyticsData(auth);
  const res = await data.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      metrics: metrics.map((m) => ({ name: m })),
      dimensions: dimensions.map((d) => ({ name: d })),
      dateRanges,
      limit,
    },
  });
  return res.data;
}

async function listConversionEvents(auth, propertyId) {
  const admin = getAnalyticsAdmin(auth);
  const res = await admin.properties.conversionEvents.list({
    parent: `properties/${propertyId}`,
  });
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

module.exports = {
  listProperties,
  listCustomDimensions,
  createCustomDimension,
  listCustomMetrics,
  runReport,
  listConversionEvents,
  duplicateCustomDimensions,
};
