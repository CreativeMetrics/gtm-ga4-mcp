const { google } = require('googleapis');

const API_DELAY_MS = 1200;  // ~50 writes/min, under GTM limit of 60/min
const READ_DELAY_MS = 300;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getTagManager(auth) {
  return google.tagmanager({ version: 'v2', auth });
}

// Strip read-only fields before POSTing to destination
function cleanEntity(obj) {
  const STRIP = new Set([
    'accountId', 'containerId', 'workspaceId', 'tagId', 'variableId',
    'triggerId', 'folderId', 'fingerprint', 'tagManagerUrl', 'path',
    'parentFolderId', 'monitoringMetadata', 'monitoringMetadataTagNameKey',
  ]);
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !STRIP.has(k)));
}

function isCustomTemplate(type) {
  return !!type && type.startsWith('cvt_');
}

function templateIdFromType(type) {
  if (!type) return null;
  const m = type.match(/^cvt_\d+_(\d+)$/);
  if (m) return m[1];
  if (/^cvt_[A-Za-z0-9]+$/.test(type)) return type;
  return null;
}

function isGalleryTemplateId(tid) {
  return typeof tid === 'string' && /^cvt_[A-Za-z0-9]+$/.test(tid);
}

// Wrapper that adds delay + exponential backoff on 429
async function apiWrite(fn, attempt = 0) {
  try {
    const res = await fn();
    await sleep(API_DELAY_MS);
    return res;
  } catch (e) {
    const msg = e.message || '';
    if ((msg.includes('429') || msg.includes('Quota')) && attempt < 5) {
      const waits = [15000, 30000, 60000, 120000, 240000];
      await sleep(waits[attempt]);
      return apiWrite(fn, attempt + 1);
    }
    throw e;
  }
}

async function getAll(gtm, path, key) {
  const res = await gtm.request({ url: `https://www.googleapis.com/tagmanager/v2/${path}` });
  await sleep(READ_DELAY_MS);
  return res.data[key] || [];
}

async function duplicateContainer(auth, srcAccountId, srcContainerId, dstAccountId, dstContainerId, options = {}) {
  const gtm = getTagManager(auth);
  const log = [];
  const warn = [];

  const srcBase = `accounts/${srcAccountId}/containers/${srcContainerId}`;
  const dstBase = `accounts/${dstAccountId}/containers/${dstContainerId}`;

  const prefix = options.prefix || '';
  const suffix = options.suffix || '';
  const rename = name => `${prefix}${name}${suffix}`;

  // ── 1. Recupera workspace sorgente (default) ─────────────────────────────
  const srcWorkspaces = await getAll(gtm, `${srcBase}/workspaces`, 'workspace');
  const srcWs = srcWorkspaces.find(w => w.name === 'Default Workspace') || srcWorkspaces[0];
  if (!srcWs) throw new Error('Nessun workspace trovato nel container sorgente.');
  const srcWsBase = `${srcBase}/workspaces/${srcWs.workspaceId}`;

  // ── 2. Crea workspace destinazione ───────────────────────────────────────
  log.push('Creazione workspace destinazione…');
  const dstWsRes = await apiWrite(() =>
    gtm.accounts.containers.workspaces.create({
      parent: dstBase,
      requestBody: { name: `Copia da ${srcContainerId} — ${new Date().toISOString().slice(0, 10)}` },
    })
  );
  const dstWs = dstWsRes.data;
  const dstWsBase = `${dstBase}/workspaces/${dstWs.workspaceId}`;
  log.push(`Workspace "${dstWs.name}" creato (ID: ${dstWs.workspaceId})`);

  // ── 3. Leggi tutto dal sorgente ──────────────────────────────────────────
  const [srcFolders, srcBuiltIn, srcTemplatesFull, srcVars, srcTrigs, srcTags] = await Promise.all([
    getAll(gtm, `${srcWsBase}/folders`, 'folder'),
    gtm.accounts.containers.workspaces.getStatus({ path: srcWsBase })
      .then(r => { sleep(READ_DELAY_MS); return []; }) // built-in handled separately
      .catch(() => []),
    getAll(gtm, `${srcWsBase}/templates`, 'template'),
    getAll(gtm, `${srcWsBase}/variables`, 'variable'),
    getAll(gtm, `${srcWsBase}/triggers`, 'trigger'),
    getAll(gtm, `${srcWsBase}/tags`, 'tag'),
  ]);

  // Built-in variables
  const srcContainerRes = await gtm.accounts.containers.get({ path: `accounts/${srcAccountId}/containers/${srcContainerId}` });
  await sleep(READ_DELAY_MS);
  const srcContainer = srcContainerRes.data;

  // ── 4. Copia cartelle ────────────────────────────────────────────────────
  const folderMap = {}; // srcFolderId → dstFolderId
  log.push(`Cartelle: ${srcFolders.length}`);
  for (const f of srcFolders) {
    try {
      const body = { name: rename(f.name) };
      const res = await apiWrite(() =>
        gtm.accounts.containers.workspaces.folders.create({
          parent: dstWsBase,
          requestBody: body,
        })
      );
      folderMap[f.folderId] = res.data.folderId;
      log.push(`  ✓ Cartella "${f.name}"`);
    } catch (e) {
      warn.push(`  ✗ Cartella "${f.name}": ${e.message}`);
    }
  }

  // ── 5. Abilita built-in variables ────────────────────────────────────────
  try {
    const builtInRes = await gtm.accounts.containers.workspaces.built_in_variables.list({
      parent: srcWsBase,
    });
    await sleep(READ_DELAY_MS);
    const builtIns = builtInRes.data.builtInVariable || [];
    if (builtIns.length) {
      const types = builtIns.map(b => b.type);
      await apiWrite(() =>
        gtm.accounts.containers.workspaces.built_in_variables.create({
          parent: dstWsBase,
          type: types,
        })
      );
      log.push(`Built-in variables abilitate: ${types.length}`);
    }
  } catch (e) {
    warn.push(`Built-in variables: ${e.message}`);
  }

  // ── 6. Installa template ─────────────────────────────────────────────────
  const typeMap = {}; // srcType → dstType
  const srcContId = srcContainerId;
  const dstContId = dstContainerId;

  // Identifica quali template servono
  const neededTmplIds = new Set();
  [...srcTags, ...srcVars].forEach(e => {
    const tid = templateIdFromType(e.type);
    if (tid) neededTmplIds.add(tid);
  });

  const byTmplId = {};
  srcTemplatesFull.forEach(t => {
    byTmplId[t.templateId] = { template: t };
  });

  const tmplEntries = [...neededTmplIds]
    .map(tid => [tid, byTmplId[tid]])
    .filter(([, v]) => v);

  const userTmplEntries = tmplEntries.filter(([tid]) => !isGalleryTemplateId(tid));
  const galleryTmplEntries = tmplEntries.filter(([tid]) => isGalleryTemplateId(tid));
  let galleryOk = 0;

  log.push(`Template: ${userTmplEntries.length} utente · ${galleryTmplEntries.length} gallery`);

  // Template creati dall'utente
  for (const [srcTid, { template }] of userTmplEntries) {
    const srcType = `cvt_${srcContId}_${srcTid}`;
    const name = template?.name || `Template ${srcTid}`;
    let dstTid = null;
    if (template?.templateData) {
      try {
        const body = { name: template.name, templateData: template.templateData };
        if (template.galleryReference) body.galleryReference = template.galleryReference;
        const resp = await apiWrite(() =>
          gtm.accounts.containers.workspaces.templates.create({
            parent: dstWsBase,
            requestBody: body,
          })
        );
        dstTid = resp.data.templateId;
        log.push(`  ✓ Template "${name}" (ID: ${dstTid})`);
      } catch (e) {
        warn.push(`  ✗ Template "${name}": ${e.message}`);
      }
    }
    if (!dstTid) {
      // Cerca se già presente in destinazione
      try {
        const existing = await getAll(gtm, `${dstWsBase}/templates`, 'template');
        const match = existing.find(t => t.name?.toLowerCase() === name.toLowerCase());
        if (match?.templateId) {
          dstTid = match.templateId;
          log.push(`  ✓ Template "${name}" già presente`);
        }
      } catch (_) {}
    }
    if (dstTid) typeMap[srcType] = `cvt_${dstContId}_${dstTid}`;
  }

  // Template gallery
  if (galleryTmplEntries.length) {
    const existDst = await getAll(gtm, `${dstWsBase}/templates`, 'template');
    const existNames = new Set(existDst.map(t => (t.name || '').toLowerCase()));

    for (const [, { template }] of galleryTmplEntries) {
      const name = template?.name || '';
      if (existNames.has(name.toLowerCase())) {
        log.push(`  ✓ Gallery template "${name}" già presente`);
        galleryOk++;
        continue;
      }
      if (!template?.templateData) {
        warn.push(`  ⚠ Gallery template "${name}": nessun templateData`);
        continue;
      }
      try {
        const body = { name: template.name, templateData: template.templateData };
        if (template.galleryReference) body.galleryReference = template.galleryReference;
        await apiWrite(() =>
          gtm.accounts.containers.workspaces.templates.create({
            parent: dstWsBase,
            requestBody: body,
          })
        );
        log.push(`  ✓ Gallery template "${name}" installato`);
        galleryOk++;
      } catch (e) {
        warn.push(`  ⚠ Gallery template "${name}": ${e.message}`);
      }
    }
  }

  // ── 7. Copia variabili ───────────────────────────────────────────────────
  const varMap = {}; // srcVariableId → dstVariableId
  log.push(`Variabili: ${srcVars.length}`);
  await sleep(3000); // pausa pre-scrittura per recuperare quota

  for (const v of srcVars) {
    try {
      const body = cleanEntity({ ...v });
      body.name = rename(v.name);
      if (body.type && typeMap[body.type]) body.type = typeMap[body.type];
      if (body.parentFolderId && folderMap[body.parentFolderId]) {
        body.parentFolderId = folderMap[body.parentFolderId];
      } else {
        delete body.parentFolderId;
      }
      const res = await apiWrite(() =>
        gtm.accounts.containers.workspaces.variables.create({
          parent: dstWsBase,
          requestBody: body,
        })
      );
      varMap[v.variableId] = res.data.variableId;
      log.push(`  ✓ Variabile "${v.name}"`);
    } catch (e) {
      warn.push(`  ✗ Variabile "${v.name}": ${e.message}`);
    }
  }

  // ── 8. Copia trigger ─────────────────────────────────────────────────────
  const trigMap = {}; // srcTriggerId → dstTriggerId
  log.push(`Trigger: ${srcTrigs.length}`);

  for (const t of srcTrigs) {
    try {
      const body = cleanEntity({ ...t });
      body.name = rename(t.name);
      if (body.parentFolderId && folderMap[body.parentFolderId]) {
        body.parentFolderId = folderMap[body.parentFolderId];
      } else {
        delete body.parentFolderId;
      }
      const res = await apiWrite(() =>
        gtm.accounts.containers.workspaces.triggers.create({
          parent: dstWsBase,
          requestBody: body,
        })
      );
      trigMap[t.triggerId] = res.data.triggerId;
      log.push(`  ✓ Trigger "${t.name}"`);
    } catch (e) {
      warn.push(`  ✗ Trigger "${t.name}": ${e.message}`);
    }
  }

  // ── 9. Copia tag ─────────────────────────────────────────────────────────
  const srcTrigIds = new Set(srcTrigs.map(t => t.triggerId));
  const remapTrigId = id => trigMap[id] || (!srcTrigIds.has(id) ? id : null);

  let tagOk = 0;
  log.push(`Tag: ${srcTags.length}`);

  for (const tag of srcTags) {
    try {
      const body = cleanEntity({ ...tag });
      body.name = rename(tag.name);

      // Remap template type
      if (body.type && typeMap[body.type]) body.type = typeMap[body.type];

      // Remap trigger IDs
      if (body.firingTriggerId) {
        body.firingTriggerId = body.firingTriggerId.map(remapTrigId).filter(Boolean);
        if (!body.firingTriggerId.length) delete body.firingTriggerId;
      }
      if (body.blockingTriggerId) {
        body.blockingTriggerId = body.blockingTriggerId.map(remapTrigId).filter(Boolean);
        if (!body.blockingTriggerId.length) delete body.blockingTriggerId;
      }
      if (body.disablingTriggerId) {
        body.disablingTriggerId = body.disablingTriggerId.map(remapTrigId).filter(Boolean);
        if (!body.disablingTriggerId.length) delete body.disablingTriggerId;
      }

      // Remap tag sequencing
      if (body.setupTag) {
        body.setupTag = body.setupTag
          .map(s => ({ ...s, tagName: rename(s.tagName) }))
          .filter(s => srcTags.some(t => rename(t.name) === s.tagName));
      }
      if (body.teardownTag) {
        body.teardownTag = body.teardownTag
          .map(s => ({ ...s, tagName: rename(s.tagName) }))
          .filter(s => srcTags.some(t => rename(t.name) === s.tagName));
      }

      // Remap folder
      if (body.parentFolderId && folderMap[body.parentFolderId]) {
        body.parentFolderId = folderMap[body.parentFolderId];
      } else {
        delete body.parentFolderId;
      }

      await apiWrite(() =>
        gtm.accounts.containers.workspaces.tags.create({
          parent: dstWsBase,
          requestBody: body,
        })
      );
      tagOk++;
      log.push(`  ✓ Tag "${tag.name}"`);
    } catch (e) {
      warn.push(`  ✗ Tag "${tag.name}": ${e.message}`);
    }
  }

  return {
    workspace: { id: dstWs.workspaceId, name: dstWs.name },
    counts: {
      folders: Object.keys(folderMap).length,
      templates: Object.keys(typeMap).length + galleryOk,
      variables: Object.keys(varMap).length,
      triggers: Object.keys(trigMap).length,
      tags: tagOk,
    },
    totals: {
      folders: srcFolders.length,
      variables: srcVars.length,
      triggers: srcTrigs.length,
      tags: srcTags.length,
    },
    log,
    warnings: warn,
    hasIssues: warn.length > 0,
  };
}

module.exports = { duplicateContainer };
