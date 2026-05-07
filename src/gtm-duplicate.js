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

  // 1c. Rileva quali template sono necessari
  const neededUserTmplIds = new Set();
  const neededGalleryTypes = new Set();
  [...srcTags, ...srcVars].forEach(e => {
    const tid = templateIdFromType(e.type);
    if (!tid) return;
    if (isGalleryTemplateId(tid)) neededGalleryTypes.add(tid);
    else neededUserTmplIds.add(tid);
  });

  // 1d. Fetch templateData completo per ogni template (la list API non la include)
  const srcTemplatesFull = {};
  for (const t of srcTemplateList) {
    try {
      const r = await auth.request({
        url: `https://www.googleapis.com/tagmanager/v2/${srcWsBase}/templates/${t.templateId}`,
        method: 'GET',
      });
      await sleep(READ_DELAY_MS);
      srcTemplatesFull[t.templateId] = r.data;
    } catch (_) {
      srcTemplatesFull[t.templateId] = t;
    }
  }

  const srcGalleryTemplates = Object.values(srcTemplatesFull).filter(t => t.galleryReference);

  log.push(`Rilevati: ${srcFolders.length} cartelle · ${srcBuiltIns.length} built-in · ${neededUserTmplIds.size} template utente · ${neededGalleryTypes.size} template gallery · ${srcVars.length} variabili · ${srcTrigs.length} trigger · ${srcTags.length} tag`);

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

  // 2b. Installa template utente PRIMA di tutto il resto
  const typeMap = {};
  let tmplUserOk = 0;
  let tmplGalleryOk = 0;

  if (neededUserTmplIds.size > 0) {
    log.push(`Template utente (${neededUserTmplIds.size})…`);
    for (const srcTid of neededUserTmplIds) {
      const t = srcTemplatesFull[srcTid];
      const srcType = `cvt_${srcContId}_${srcTid}`;
      const name = t?.name || `Template ${srcTid}`;
      let dstTid = null;

      if (t?.templateData) {
        try {
          const body = { name: t.name, templateData: t.templateData };
          if (t.galleryReference) body.galleryReference = t.galleryReference;
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
      }

      if (!dstTid) {
        try {
          const existing = await getAll(auth, `${dstWsBase}/templates`, 'template');
          const match = existing.find(x => x.name?.toLowerCase() === name.toLowerCase());
          if (match?.templateId) {
            dstTid = match.templateId;
            log.push(`  ✓ "${name}" già presente (ID: ${dstTid})`);
            tmplUserOk++;
          }
        } catch (_) {}
      }

      if (dstTid) typeMap[srcType] = `cvt_${dstContId}_${dstTid}`;
      else warn.push(`  ⚠ Template "${name}" non installato — i tag che lo usano potrebbero fallire`);
    }
  }

  // 2c. Installa template gallery PRIMA di copiare tag/variabili
  const manualTemplates = []; // template che richiedono installazione manuale
  if (neededGalleryTypes.size > 0) {
    log.push(`Template gallery (${neededGalleryTypes.size})…`);
    const existDst = await getAll(auth, `${dstWsBase}/templates`, 'template');
    const existNames = new Set(existDst.map(t => (t.name || '').toLowerCase()));

    for (const srcTmpl of srcGalleryTemplates) {
      const name = srcTmpl.name || '';
      if (existNames.has(name.toLowerCase())) {
        log.push(`  ✓ "${name}" già presente`);
        tmplGalleryOk++;
        continue;
      }
      if (!srcTmpl.templateData) {
        manualTemplates.push(name);
        warn.push(`  ⚠ "${name}": richiede installazione manuale (Google non espone templateData via API per questo template)`);
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
        warn.push(`  ⚠ Gallery template "${name}": ${e.message}`);
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

  const manualSteps = [];
  if (manualTemplates.length > 0) {
    manualSteps.push(
      `⚠ ${manualTemplates.length} template richiedono installazione manuale in GTM:`,
      ...manualTemplates.map(n => `  → Cerca "${n}" nella Gallery di GTM (Modelli > Cerca nella galleria) e installalo nel container destinazione`),
      `  Dopo l'installazione manuale i tag che usano questi template funzioneranno correttamente.`
    );
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
      templates: neededUserTmplIds.size + neededGalleryTypes.size,
      folders: srcFolders.length,
      variables: srcVars.length,
      triggers: srcTrigs.length,
      tags: srcTags.length,
    },
    log,
    warnings: warn,
    manualSteps: manualSteps.length > 0 ? manualSteps : undefined,
    hasIssues: warn.length > 0,
  };
}

module.exports = { duplicateContainer };
