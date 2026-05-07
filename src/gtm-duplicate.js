const { google } = require('googleapis');

const API_DELAY_MS = 1200;  // ~50 writes/min, under GTM limit of 60/min
const READ_DELAY_MS = 300;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getTagManager(auth) {
  return google.tagmanager({ version: 'v2', auth });
}

function cleanEntity(obj) {
  const STRIP = new Set([
    'accountId', 'containerId', 'workspaceId', 'tagId', 'variableId',
    'triggerId', 'folderId', 'fingerprint', 'tagManagerUrl', 'path',
    'parentFolderId', 'monitoringMetadata', 'monitoringMetadataTagNameKey',
  ]);
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !STRIP.has(k)));
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

async function getAll(auth, path, key) {
  const r = await auth.request({
    url: `https://www.googleapis.com/tagmanager/v2/${path}`,
    method: 'GET',
  });
  await sleep(READ_DELAY_MS);
  return (r.data && r.data[key]) || [];
}

async function duplicateContainer(auth, srcAccountId, srcContainerId, dstAccountId, dstContainerId, options = {}) {
  const gtm = getTagManager(auth);
  const log = [];
  const warn = [];

  const srcBase = `accounts/${srcAccountId}/containers/${srcContainerId}`;
  const dstBase = `accounts/${dstAccountId}/containers/${dstContainerId}`;
  const srcContId = srcContainerId;
  const dstContId = dstContainerId;

  const prefix = options.prefix || '';
  const suffix = options.suffix || '';
  const rename = name => `${prefix}${name}${suffix}`;

  // ════════════════════════════════════════════════════════════
  // FASE 1 — LETTURA SORGENTE + RILEVAMENTO TEMPLATE
  // ════════════════════════════════════════════════════════════

  // 1a. Workspace sorgente
  const srcWorkspaces = await getAll(auth, `${srcBase}/workspaces`, 'workspace');
  const srcWs = srcWorkspaces.find(w => w.name === 'Default Workspace') || srcWorkspaces[0];
  if (!srcWs) throw new Error('Nessun workspace trovato nel container sorgente.');
  const srcWsBase = `${srcBase}/workspaces/${srcWs.workspaceId}`;

  // 1b. Leggi tutto in parallelo
  const [srcFolders, srcTemplateList, srcVars, srcTrigs, srcTags, builtInRes] = await Promise.all([
    getAll(auth, `${srcWsBase}/folders`, 'folder'),
    getAll(auth, `${srcWsBase}/templates`, 'template'),
    getAll(auth, `${srcWsBase}/variables`, 'variable'),
    getAll(auth, `${srcWsBase}/triggers`, 'trigger'),
    getAll(auth, `${srcWsBase}/tags`, 'tag'),
    gtm.accounts.containers.workspaces.built_in_variables.list({ parent: srcWsBase })
      .then(r => { sleep(READ_DELAY_MS); return r; })
      .catch(() => ({ data: {} })),
  ]);
  const srcBuiltIns = builtInRes.data.builtInVariable || [];

  // 1c. Stessa logica dell'estensione: byTmplId indicizzato per templateId (numerico)
  //     per template utente, e per tipo (cvt_XXXXX) per gallery
  const tmplById = {};
  srcTemplateList.forEach(t => { if (t.templateId) tmplById[t.templateId] = t; });

  const byTmplId = {};
  srcTemplateList.forEach(t => {
    if (!t.templateId) return;
    byTmplId[t.templateId] = { template: t };
  });
  [...srcTags, ...srcVars].forEach(e => {
    const tid = templateIdFromType(e.type);
    if (!tid) return;
    if (!byTmplId[tid]) byTmplId[tid] = { template: tmplById[tid] || null };
  });

  const neededTmplIds = new Set(
    [...srcTags, ...srcVars]
      .map(e => templateIdFromType(e.type))
      .filter(Boolean)
  );
  const tmplEntries = [...neededTmplIds]
    .map(tid => [tid, byTmplId[tid]])
    .filter(([, v]) => v);

  const userTmplEntries    = tmplEntries.filter(([tid]) => !isGalleryTemplateId(tid));
  const galleryTypesNeeded = new Set(tmplEntries.filter(([tid]) => isGalleryTemplateId(tid)).map(([tid]) => tid));

  log.push(`Rilevati: ${srcFolders.length} cartelle · ${srcBuiltIns.length} built-in · ${userTmplEntries.length} template utente · ${galleryTypesNeeded.size} template gallery · ${srcVars.length} variabili · ${srcTrigs.length} trigger · ${srcTags.length} tag`);

  // ════════════════════════════════════════════════════════════
  // FASE 2 — SCRITTURA (ordine: workspace → template → cartelle → built-in → variabili → trigger → tag)
  // ════════════════════════════════════════════════════════════

  // 2a. Crea workspace destinazione
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

  // 2b + 2c. Installa tutti i template PRIMA di copiare variabili/trigger/tag
  //          Logica portata 1:1 dall'estensione Chrome
  const typeMap = {};
  let tmplUserOk = 0;
  let tmplGalleryOk = 0;

  if (tmplEntries.length > 0) {
    log.push(`Template (${tmplEntries.length}) — installazione…`);

    // Ri-fetch della lista per avere templateData (stesso approccio dell'estensione)
    const srcFull = await getAll(auth, `${srcWsBase}/templates`, 'template');
    const srcFullById = {};
    srcFull.forEach(t => { if (t.templateId) srcFullById[t.templateId] = t; });

    // ── Template utente (cvt_<containerId>_<numericId>) ──────────────────
    for (const [srcTid, { template }] of userTmplEntries) {
      const srcType = `cvt_${srcContId}_${srcTid}`;
      const sf = srcFullById[srcTid] || template;
      const name = sf?.name || template?.name || `Template ${srcTid}`;
      let dstTid = null;

      if (sf?.templateData) {
        try {
          const body = { name: sf.name, templateData: sf.templateData };
          if (sf.galleryReference) body.galleryReference = sf.galleryReference;
          const resp = await apiWrite(() =>
            gtm.accounts.containers.workspaces.templates.create({
              parent: dstWsBase,
              requestBody: body,
            })
          );
          dstTid = resp.data.templateId;
          log.push(`  ✓ "${name}" (ID: ${dstTid})`);
          tmplUserOk++;
        } catch (e) {
          warn.push(`  ✗ Template "${name}": ${e.message}`);
        }
      } else {
        warn.push(`  ⚠ Nessun templateData per "${name}"`);
      }

      if (!dstTid) {
        const existing = await getAll(auth, `${dstWsBase}/templates`, 'template').catch(() => []);
        const match = existing.find(x => x.name?.toLowerCase() === name.toLowerCase());
        if (match?.templateId) {
          dstTid = match.templateId;
          log.push(`  ✓ "${name}" già presente (ID: ${dstTid})`);
          tmplUserOk++;
        } else {
          warn.push(`  ✗ "${name}" non installabile`);
        }
      }

      if (dstTid) typeMap[srcType] = `cvt_${dstContId}_${dstTid}`;
    }

    // ── Template gallery (cvt_XXXXX — ID universale, no remapping) ───────
    if (galleryTypesNeeded.size > 0) {
      const srcGallery = srcFull.filter(t => t.galleryReference);
      const existDst = await getAll(auth, `${dstWsBase}/templates`, 'template').catch(() => []);
      const existNames = new Set(existDst.map(t => (t.name || '').toLowerCase()));

      for (const srcTmpl of srcGallery) {
        const name = srcTmpl.name || `Template ${srcTmpl.templateId}`;
        if (existNames.has(name.toLowerCase())) {
          log.push(`  ✓ "${name}" già presente`);
          tmplGalleryOk++;
          continue;
        }
        if (!srcTmpl.templateData) {
          warn.push(`  ⚠ "${name}": nessun templateData`);
          continue;
        }
        try {
          const body = { name: srcTmpl.name, templateData: srcTmpl.templateData };
          if (srcTmpl.galleryReference) body.galleryReference = srcTmpl.galleryReference;
          await apiWrite(() =>
            gtm.accounts.containers.workspaces.templates.create({
              parent: dstWsBase,
              requestBody: body,
            })
          );
          log.push(`  ✓ "${name}" installato`);
          tmplGalleryOk++;
        } catch (e) {
          warn.push(`  ⚠ "${name}": ${e.message}`);
        }
      }
    }
  }

  // 2d. Copia cartelle
  const folderMap = {};
  if (srcFolders.length) {
    log.push(`Cartelle (${srcFolders.length})…`);
    for (const f of srcFolders) {
      try {
        const res = await apiWrite(() =>
          gtm.accounts.containers.workspaces.folders.create({
            parent: dstWsBase,
            requestBody: { name: rename(f.name) },
          })
        );
        folderMap[f.folderId] = res.data.folderId;
        log.push(`  ✓ "${f.name}"`);
      } catch (e) {
        warn.push(`  ✗ Cartella "${f.name}": ${e.message}`);
      }
    }
  }

  // 2e. Abilita built-in variables
  if (srcBuiltIns.length) {
    try {
      const types = srcBuiltIns.map(b => b.type);
      await apiWrite(() =>
        gtm.accounts.containers.workspaces.built_in_variables.create({
          parent: dstWsBase,
          type: types,
        })
      );
      log.push(`Built-in variables abilitate: ${types.length}`);
    } catch (e) {
      warn.push(`Built-in variables: ${e.message}`);
    }
  }

  await sleep(3000); // pausa per recuperare quota API prima delle scritture massive

  // 2f. Copia variabili
  const varMap = {};
  log.push(`Variabili (${srcVars.length})…`);
  for (const v of srcVars) {
    try {
      const body = cleanEntity({ ...v });
      body.name = rename(v.name);
      if (body.type && typeMap[body.type]) body.type = typeMap[body.type];
      if (body.parentFolderId && folderMap[body.parentFolderId]) body.parentFolderId = folderMap[body.parentFolderId];
      else delete body.parentFolderId;
      const res = await apiWrite(() =>
        gtm.accounts.containers.workspaces.variables.create({ parent: dstWsBase, requestBody: body })
      );
      varMap[v.variableId] = res.data.variableId;
      log.push(`  ✓ "${v.name}"`);
    } catch (e) {
      warn.push(`  ✗ Variabile "${v.name}": ${e.message}`);
    }
  }

  // 2g. Copia trigger
  const trigMap = {};
  log.push(`Trigger (${srcTrigs.length})…`);
  for (const t of srcTrigs) {
    try {
      const body = cleanEntity({ ...t });
      body.name = rename(t.name);
      if (body.parentFolderId && folderMap[body.parentFolderId]) body.parentFolderId = folderMap[body.parentFolderId];
      else delete body.parentFolderId;
      const res = await apiWrite(() =>
        gtm.accounts.containers.workspaces.triggers.create({ parent: dstWsBase, requestBody: body })
      );
      trigMap[t.triggerId] = res.data.triggerId;
      log.push(`  ✓ "${t.name}"`);
    } catch (e) {
      warn.push(`  ✗ Trigger "${t.name}": ${e.message}`);
    }
  }

  // 2h. Copia tag
  const srcTrigIds = new Set(srcTrigs.map(t => t.triggerId));
  const remapTrigId = id => trigMap[id] || (!srcTrigIds.has(id) ? id : null);
  let tagOk = 0;

  log.push(`Tag (${srcTags.length})…`);
  for (const tag of srcTags) {
    try {
      const body = cleanEntity({ ...tag });
      body.name = rename(tag.name);
      if (body.type && typeMap[body.type]) body.type = typeMap[body.type];
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
      if (body.parentFolderId && folderMap[body.parentFolderId]) body.parentFolderId = folderMap[body.parentFolderId];
      else delete body.parentFolderId;

      await apiWrite(() =>
        gtm.accounts.containers.workspaces.tags.create({ parent: dstWsBase, requestBody: body })
      );
      tagOk++;
      log.push(`  ✓ "${tag.name}"`);
    } catch (e) {
      warn.push(`  ✗ Tag "${tag.name}": ${e.message}`);
    }
  }

  return {
    workspace: { id: dstWs.workspaceId, name: dstWs.name },
    counts: {
      templates: tmplUserOk + tmplGalleryOk,
      folders: Object.keys(folderMap).length,
      variables: Object.keys(varMap).length,
      triggers: Object.keys(trigMap).length,
      tags: tagOk,
    },
    totals: {
      templates: tmplEntries.length,
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
