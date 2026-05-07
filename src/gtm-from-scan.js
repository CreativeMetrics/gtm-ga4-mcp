const { google } = require('googleapis');
const https = require('https');
const { scanUrl } = require('./tag-detector.js');

const API_DELAY_MS = 1200;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getGtm(auth) {
  return google.tagmanager({ version: 'v2', auth });
}

// ── Gallery template references ───────────────────────────────────────────────
// githubRepo: owner/repo path on GitHub — used to fetch templateData from raw .tpl file
const GALLERY_REFS = {
  metaPixel: { owner: 'stape-io',  repository: 'fb-tag',                          name: 'Meta Pixel',           paramKey: 'pixelId',   githubRepo: 'stape-io/fb-tag'                          },
  linkedin:  { owner: 'linkedin',  repository: 'linkedin-gtm-community-template', name: 'LinkedIn Insight Tag', paramKey: 'partnerId', githubRepo: 'linkedin/linkedin-gtm-community-template'  },
  clarity:   { owner: 'microsoft', repository: 'clarity-gtm-template',            name: 'Microsoft Clarity',    paramKey: 'projectId', githubRepo: 'microsoft/clarity-gtm-template'            },
  tiktok:    { owner: 'tiktok',    repository: 'gtm-template-pixel',              name: 'TikTok Pixel',         paramKey: 'pixelCode', githubRepo: 'tiktok/gtm-template-pixel'                 },
  pinterest: { owner: 'pinterest', repository: 'ws-gtm-template',                 name: 'Pinterest Tag',        paramKey: 'tagId',     githubRepo: 'pinterest/ws-gtm-template'                 },
};

// Fetch templateData from GitHub raw .tpl file
function fetchTemplateData(githubRepo) {
  const url = `https://raw.githubusercontent.com/${githubRepo}/main/template.tpl`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'gtm-ga4-mcp' } }, res => {
      if (res.statusCode === 404) {
        // try master branch
        https.get(url.replace('/main/', '/master/'), { headers: { 'User-Agent': 'gtm-ga4-mcp' } }, res2 => {
          let data = '';
          res2.on('data', c => { data += c; });
          res2.on('end', () => res2.statusCode === 200 ? resolve(data) : reject(new Error(`Template .tpl non trovato (${res2.statusCode})`)));
        }).on('error', reject);
        return;
      }
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => res.statusCode === 200 ? resolve(data) : reject(new Error(`Template .tpl non trovato (${res.statusCode})`)));
    }).on('error', reject);
  });
}

// ── Tag configuration map ─────────────────────────────────────────────────────
// Maps detected tag name → how to build the GTM tag
// buildTag(ids, triggerId, templateType) → tag body or null
const TAG_CONFIGS = {

  'Google Analytics 4 (GA4)': {
    buildTag: (ids, triggerId) => {
      if (!ids.ga4) return null;
      return {
        name: `GA4 — ${ids.ga4}`,
        type: 'googtag',
        parameter: [{ type: 'template', key: 'tagId', value: ids.ga4 }],
        firingTriggerId: [triggerId],
      };
    },
  },

  'Google Ads / Conversion': {
    buildTag: (ids, triggerId) => {
      if (!ids.googleAdsId) return null;
      if (ids.googleAdsConversionLabel) {
        return {
          name: `Google Ads Conversion — AW-${ids.googleAdsId}`,
          type: 'awct',
          parameter: [
            { type: 'template', key: 'conversionId',    value: ids.googleAdsId },
            { type: 'template', key: 'conversionLabel', value: ids.googleAdsConversionLabel },
          ],
          firingTriggerId: [triggerId],
        };
      }
      return {
        name: `Google Tag — AW-${ids.googleAdsId}`,
        type: 'googtag',
        parameter: [{ type: 'template', key: 'tagId', value: `AW-${ids.googleAdsId}` }],
        firingTriggerId: [triggerId],
      };
    },
  },

  'Meta (Facebook) Pixel': {
    galleryKey: 'metaPixel',
    buildTag: (ids, triggerId, templateType) => {
      if (!ids.metaPixel) return null;
      return {
        name: `Meta Pixel — ${ids.metaPixel}`,
        type: templateType,
        parameter: [{ type: 'template', key: 'pixelId', value: ids.metaPixel }],
        firingTriggerId: [triggerId],
      };
    },
  },

  'LinkedIn Insight Tag': {
    galleryKey: 'linkedin',
    buildTag: (ids, triggerId, templateType) => {
      if (!ids.linkedin) return null;
      return {
        name: `LinkedIn Insight Tag — ${ids.linkedin}`,
        type: templateType,
        parameter: [{ type: 'template', key: 'partnerId', value: ids.linkedin }],
        firingTriggerId: [triggerId],
      };
    },
  },

  'Microsoft Clarity': {
    galleryKey: 'clarity',
    buildTag: (ids, triggerId, templateType) => {
      if (!ids.clarity) return null;
      return {
        name: `Microsoft Clarity — ${ids.clarity}`,
        type: templateType,
        parameter: [{ type: 'template', key: 'projectId', value: ids.clarity }],
        firingTriggerId: [triggerId],
      };
    },
  },

  'TikTok Pixel': {
    galleryKey: 'tiktok',
    buildTag: (ids, triggerId, templateType) => {
      if (!ids.tiktok) return null;
      return {
        name: `TikTok Pixel — ${ids.tiktok}`,
        type: templateType,
        parameter: [{ type: 'template', key: 'pixelCode', value: ids.tiktok }],
        firingTriggerId: [triggerId],
      };
    },
  },

  'Pinterest Tag': {
    galleryKey: 'pinterest',
    buildTag: (ids, triggerId, templateType) => {
      if (!ids.pinterest) return null;
      return {
        name: `Pinterest Tag — ${ids.pinterest}`,
        type: templateType,
        parameter: [{ type: 'template', key: 'tagId', value: ids.pinterest }],
        firingTriggerId: [triggerId],
      };
    },
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function apiWrite(fn, attempt = 0) {
  try {
    const res = await fn();
    await sleep(API_DELAY_MS);
    return res;
  } catch (e) {
    const msg = e.message || '';
    if ((msg.includes('429') || msg.includes('Quota')) && attempt < 5) {
      await sleep([15000, 30000, 60000, 120000, 240000][attempt]);
      return apiWrite(fn, attempt + 1);
    }
    throw e;
  }
}

// Returns or creates an "All Pages" page view trigger
async function getOrCreateAllPagesTrigger(gtm, wsPath) {
  const res = await gtm.accounts.containers.workspaces.triggers.list({ parent: wsPath });
  const triggers = res.data.trigger || [];
  const existing = triggers.find(t => t.type === 'PAGEVIEW' && (!t.filter || t.filter.length === 0));
  if (existing) return existing.triggerId;

  const created = await apiWrite(() =>
    gtm.accounts.containers.workspaces.triggers.create({
      parent: wsPath,
      requestBody: { name: 'All Pages', type: 'PAGEVIEW' },
    })
  );
  return created.data.triggerId;
}

// Installs a gallery template and returns its type string (cvt_{contId}_{tmplId})
// Tries gallery reference first; if that fails, searches by name in existing templates
async function installGalleryTemplate(gtm, wsPath, containerId, galleryRef) {
  // Check if already installed
  const listRes = await gtm.accounts.containers.workspaces.templates.list({ parent: wsPath });
  const existing = (listRes.data.template || []).find(
    t => t.name?.toLowerCase() === galleryRef.name.toLowerCase()
  );
  if (existing) {
    return `cvt_${containerId}_${existing.templateId}`;
  }

  // Fetch templateData from GitHub and install
  let templateData;
  try {
    templateData = await fetchTemplateData(galleryRef.githubRepo);
  } catch (e) {
    throw new Error(`Impossibile scaricare template "${galleryRef.name}" da GitHub: ${e.message}`);
  }

  try {
    const res = await apiWrite(() =>
      gtm.accounts.containers.workspaces.templates.create({
        parent: wsPath,
        requestBody: { name: galleryRef.name, templateData },
      })
    );
    return `cvt_${containerId}_${res.data.templateId}`;
  } catch (e) {
    throw new Error(`Template "${galleryRef.name}" non installabile: ${e.message}`);
  }
}

// ── Main function ─────────────────────────────────────────────────────────────

async function createTagsFromUrl(auth, url, accountId, containerId, workspaceId) {
  const gtm = getGtm(auth);
  const log = [];
  const warn = [];

  // 1. Scan URL
  log.push(`Scansione ${url}…`);
  const scan = await scanUrl(url);
  log.push(`Rilevati ${scan.tags_found} tag sul sito`);

  const ids = scan.extracted_ids;
  const detectedNames = new Set(scan.tags.map(t => t.name));

  // Determine which tags we can configure
  const toCreate = [];
  for (const [tagName, config] of Object.entries(TAG_CONFIGS)) {
    if (!detectedNames.has(tagName)) continue;
    toCreate.push({ tagName, config });
  }

  if (toCreate.length === 0) {
    return { url, scan_summary: { tags_found: scan.tags_found }, created: [], warnings: ['Nessun tag configurabile rilevato (GA4, Ads, Meta, LinkedIn, Clarity, TikTok, Pinterest).'] };
  }

  // 2. Resolve workspace
  let wsId = workspaceId;
  if (!wsId) {
    const wsRes = await gtm.accounts.containers.workspaces.list({
      parent: `accounts/${accountId}/containers/${containerId}`,
    });
    const wsList = wsRes.data.workspace || [];
    const defaultWs = wsList.find(w => w.name === 'Default Workspace') || wsList[0];
    if (!defaultWs) throw new Error('Nessun workspace trovato nel container.');
    wsId = defaultWs.workspaceId;
  }

  // 3. Create new workspace for this operation
  log.push('Creazione workspace…');
  const domain = new URL(scan.url).hostname.replace(/^www\./, '');
  const newWsRes = await apiWrite(() =>
    gtm.accounts.containers.workspaces.create({
      parent: `accounts/${accountId}/containers/${containerId}`,
      requestBody: { name: `Import da ${domain} — ${new Date().toISOString().slice(0, 10)}` },
    })
  );
  const newWs = newWsRes.data;
  const wsPath = `accounts/${accountId}/containers/${containerId}/workspaces/${newWs.workspaceId}`;
  log.push(`Workspace "${newWs.name}" creato (ID: ${newWs.workspaceId})`);

  // 4. Get or create All Pages trigger
  const triggerId = await getOrCreateAllPagesTrigger(gtm, wsPath);
  log.push(`Trigger "All Pages" pronto (ID: ${triggerId})`);

  // 5. Install gallery templates + create tags
  const created = [];

  for (const { tagName, config } of toCreate) {
    let templateType = null;

    // Install gallery template if needed
    if (config.galleryKey) {
      const galleryRef = GALLERY_REFS[config.galleryKey];
      try {
        templateType = await installGalleryTemplate(gtm, wsPath, containerId, galleryRef);
        log.push(`  ✓ Template "${galleryRef.name}" pronto`);
      } catch (e) {
        warn.push(`  ✗ ${tagName}: ${e.message}`);
        continue;
      }
    }

    // Build tag body
    const tagBody = config.buildTag(ids, triggerId, templateType);
    if (!tagBody) {
      warn.push(`  ⚠ ${tagName}: ID non estratto dalla pagina — configura manualmente`);
      continue;
    }

    // Create the tag
    try {
      await apiWrite(() =>
        gtm.accounts.containers.workspaces.tags.create({
          parent: wsPath,
          requestBody: tagBody,
        })
      );
      log.push(`  ✓ Tag "${tagBody.name}" creato`);
      created.push({ name: tagBody.name, type: tagBody.type });
    } catch (e) {
      warn.push(`  ✗ Tag "${tagBody.name}": ${e.message}`);
    }
  }

  return {
    url: scan.url,
    workspace: { id: newWs.workspaceId, name: newWs.name },
    scan_summary: {
      tags_found: scan.tags_found,
      cookie_banner_accepted: scan.cookie_banner_accepted,
      extracted_ids: ids,
    },
    created,
    log,
    warnings: warn,
    note: created.length > 0
      ? `${created.length} tag creati nel workspace "${newWs.name}". Verifica la configurazione prima di pubblicare.`
      : 'Nessun tag creato.',
  };
}

module.exports = { createTagsFromUrl };
