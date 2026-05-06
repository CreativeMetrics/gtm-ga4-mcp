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

  const prefix = options.prefix || '';
  const suffix = options.suffix || '';
  const rename = name => `${prefix}${name}${suffix}`;

  // ── 1. Recupera workspace sorgente (default) ─────────────────────────────
  const srcWorkspaces = await getAll(auth, `${srcBase}/workspaces`, 'workspace');
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

  // ── 3. Leggi tutto dal sorgente in parallelo ─────────────────────────────
  const [srcFolders, srcTemplatesFull, srcVars, srcTrigs, srcTags] = await Promise.all([
    getAll(auth, `${srcWsBase}/folders`, 'folder'),
    getAll(auth, `${srcWsBase}/templates`, 'template'),
    getAll(auth, `${srcWsBase}/variables`, 'variable'),
    getAll(auth, `${srcWsBase}/triggers`, 'trigger'),
    getAll(auth, `${srcWsBase}/tags`, 'tag'),
  ]);

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
  const typeMap = {}; // srcType → dstType (solo per template utente)
  const srcContId = srcContainerId;
  const dstContId = dstContainerId;

  // Identifica template usati da tag e variabili
  const neededUserTmplIds = new Set();  // numeric ids per template utente
  const neededGalleryTypes = new Set(); // cvt_XXXXX per gallery
  [...srcTags, ...srcVars].forEach(e => {
    const tid = templateIdFromType(e.type);
    if (!tid) return;
    if (isGalleryTemplateId(tid)) neededGalleryTypes.add(tid);
    else neededUserTmplIds.add(tid);
  });

  // Fetch templateData individuale per ogni template (la list API non la restituisce)
  const srcTemplatesByNumericId = {};
  for (const t of srcTemplatesFull) {
    try {
      const r = await auth.request({
        url: `https://www.googleapis.com/tagmanager/v2/${srcWsBase}/templates/${t.templateId}`,
        method: 'GET',
      });
      await sleep(READ_DELAY_MS);
      srcTemplatesByNumericId[t.templateId] = r.data;
    } catch (_) {
      srcTemplatesByNumericId[t.templateId] = t;
    }
  }

  const srcGalleryTemplates = Object.values(srcTemplatesByNumericId).filter(t => t.galleryReference);
  const srcUserTemplates    = Object.values(srcTemplatesByNumericId).filter(t => !t.galleryReference);

  log.push(`Template: ${neededUserTmplIds.size} utente · ${neededGalleryTypes.size} gallery`);

  // ── Template utente (cvt_<containerId>_<numericId>) ──────────────────────
  for (const srcTid of neededUserTmplIds) {
    const t = srcTemplatesByNumericId[srcTid];
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
        log.push(`  ✓ Template "${name}" (ID: ${dstTid})`);
      } catch (e) {
        warn.push(`  ✗ Template "${name}": ${e.message}`);
      }
    }

    // Se creazione fallita, cerca se già presente per nome
    if (!dstTid) {
      try {
        const existing = await getAll(auth, `${dstWsBase}/templates`, 'template');
        const match = existing.find(x => x.name?.toLowerCase() === name.toLowerCase());
        if (match?.templateId) {
          dstTid = match.templateId;
          log.push(`  ✓ Template "${name}" già presente (ID: ${dstTid})`);
        }
      } catch (_) {}
    }

    if (dstTid) typeMap[srcType] = `cvt_${dstContId}_${dstTid}`;
    else warn.push(`  ⚠ Template "${name}" (${srcType}) non installato — verifica manualmente`);
  }

  // ── Template gallery (cvt_XXXXX — ID universale, no remapping necessario) ─
  if (neededGalleryTypes.size > 0) {
    const existDst = await getAll(auth, `${dstWsBase}/templates`, 'template');
    const existNames = new Set(existDst.map(t => (t.name || '').toLowerCase()));
    let galleryOk = 0;

    for (const srcTmpl of srcGalleryTemplates) {
      const name = srcTmpl.name || '';
      if (existNames.has(name.toLowerCase())) {
        log.push(`  ✓ Gallery template "${name}" già presente`);
        galleryOk++;
        continue;
      }
      if (!srcTmpl.templateData) {
        warn.push(`  ⚠ Gallery template "${name}": templateData non disponibile`);
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
        log.push(`  ✓ Gallery template "${name}" installato`);
        galleryOk++;
      } catch (e) {
        warn.push(`  ⚠ Gallery template "${name}": ${e.message}`);
      }
    }
    log.push(`Gallery template: ${galleryOk}/${srcGalleryTemplates.length}`);
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
