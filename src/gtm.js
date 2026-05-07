const { google } = require('googleapis');

function getTagManager(auth) {
  return google.tagmanager({ version: 'v2', auth });
}

async function listAccounts(auth) {
  const gtm = getTagManager(auth);
  const res = await gtm.accounts.list();
  return res.data.account || [];
}

async function listContainers(auth, accountId) {
  const gtm = getTagManager(auth);
  const res = await gtm.accounts.containers.list({
    parent: `accounts/${accountId}`,
  });
  return res.data.container || [];
}

async function listWorkspaces(auth, accountId, containerId) {
  const gtm = getTagManager(auth);
  const res = await gtm.accounts.containers.workspaces.list({
    parent: `accounts/${accountId}/containers/${containerId}`,
  });
  return res.data.workspace || [];
}

const wsCache = new Map();

async function resolveWorkspaceId(auth, accountId, containerId, workspaceId) {
  if (workspaceId) return workspaceId;
  const cacheKey = `${accountId}:${containerId}`;
  if (wsCache.has(cacheKey)) return wsCache.get(cacheKey);
  const workspaces = await listWorkspaces(auth, accountId, containerId);
  if (!workspaces.length) throw new Error('Nessun workspace trovato nel container.');
  const defaultWs = workspaces.find(w => w.name === 'Default Workspace') || workspaces[0];
  wsCache.set(cacheKey, defaultWs.workspaceId);
  return defaultWs.workspaceId;
}

async function listTemplates(auth, accountId, containerId, workspaceId) {
  const gtm = getTagManager(auth);
  const wsId = await resolveWorkspaceId(auth, accountId, containerId, workspaceId);
  const res = await gtm.accounts.containers.workspaces.templates.list({
    parent: `accounts/${accountId}/containers/${containerId}/workspaces/${wsId}`,
  });
  return res.data.template || [];
}

async function createWorkspace(auth, accountId, containerId, name, description) {
  const gtm = getTagManager(auth);
  const res = await gtm.accounts.containers.workspaces.create({
    parent: `accounts/${accountId}/containers/${containerId}`,
    requestBody: { name, description: description || '' },
  });
  return res.data;
}

// ── TAGS ──────────────────────────────────────────────────────────────────────

async function listTags(auth, accountId, containerId, workspaceId) {
  const gtm = getTagManager(auth);
  const wsId = await resolveWorkspaceId(auth, accountId, containerId, workspaceId);
  const res = await gtm.accounts.containers.workspaces.tags.list({
    parent: `accounts/${accountId}/containers/${containerId}/workspaces/${wsId}`,
  });
  return res.data.tag || [];
}

async function createTag(auth, accountId, containerId, workspaceId, tagBody) {
  const gtm = getTagManager(auth);
  const wsId = await resolveWorkspaceId(auth, accountId, containerId, workspaceId);
  const res = await gtm.accounts.containers.workspaces.tags.create({
    parent: `accounts/${accountId}/containers/${containerId}/workspaces/${wsId}`,
    requestBody: tagBody,
  });
  return res.data;
}

async function updateTag(auth, accountId, containerId, workspaceId, tagId, tagBody) {
  const gtm = getTagManager(auth);
  const wsId = await resolveWorkspaceId(auth, accountId, containerId, workspaceId);
  const res = await gtm.accounts.containers.workspaces.tags.update({
    path: `accounts/${accountId}/containers/${containerId}/workspaces/${wsId}/tags/${tagId}`,
    requestBody: tagBody,
  });
  return res.data;
}

async function deleteTag(auth, accountId, containerId, workspaceId, tagId) {
  const gtm = getTagManager(auth);
  const wsId = await resolveWorkspaceId(auth, accountId, containerId, workspaceId);
  await gtm.accounts.containers.workspaces.tags.delete({
    path: `accounts/${accountId}/containers/${containerId}/workspaces/${wsId}/tags/${tagId}`,
  });
  return { deleted: true, tagId };
}

// ── TRIGGERS ──────────────────────────────────────────────────────────────────

async function listTriggers(auth, accountId, containerId, workspaceId) {
  const gtm = getTagManager(auth);
  const wsId = await resolveWorkspaceId(auth, accountId, containerId, workspaceId);
  const res = await gtm.accounts.containers.workspaces.triggers.list({
    parent: `accounts/${accountId}/containers/${containerId}/workspaces/${wsId}`,
  });
  return res.data.trigger || [];
}

async function createTrigger(auth, accountId, containerId, workspaceId, triggerBody) {
  const gtm = getTagManager(auth);
  const wsId = await resolveWorkspaceId(auth, accountId, containerId, workspaceId);
  const res = await gtm.accounts.containers.workspaces.triggers.create({
    parent: `accounts/${accountId}/containers/${containerId}/workspaces/${wsId}`,
    requestBody: triggerBody,
  });
  return res.data;
}

async function updateTrigger(auth, accountId, containerId, workspaceId, triggerId, triggerBody) {
  const gtm = getTagManager(auth);
  const wsId = await resolveWorkspaceId(auth, accountId, containerId, workspaceId);
  const res = await gtm.accounts.containers.workspaces.triggers.update({
    path: `accounts/${accountId}/containers/${containerId}/workspaces/${wsId}/triggers/${triggerId}`,
    requestBody: triggerBody,
  });
  return res.data;
}

async function deleteTrigger(auth, accountId, containerId, workspaceId, triggerId) {
  const gtm = getTagManager(auth);
  const wsId = await resolveWorkspaceId(auth, accountId, containerId, workspaceId);
  await gtm.accounts.containers.workspaces.triggers.delete({
    path: `accounts/${accountId}/containers/${containerId}/workspaces/${wsId}/triggers/${triggerId}`,
  });
  return { deleted: true, triggerId };
}

// ── VARIABLES ─────────────────────────────────────────────────────────────────

async function listVariables(auth, accountId, containerId, workspaceId) {
  const gtm = getTagManager(auth);
  const wsId = await resolveWorkspaceId(auth, accountId, containerId, workspaceId);
  const res = await gtm.accounts.containers.workspaces.variables.list({
    parent: `accounts/${accountId}/containers/${containerId}/workspaces/${wsId}`,
  });
  return res.data.variable || [];
}

async function createVariable(auth, accountId, containerId, workspaceId, variableBody) {
  const gtm = getTagManager(auth);
  const wsId = await resolveWorkspaceId(auth, accountId, containerId, workspaceId);
  const res = await gtm.accounts.containers.workspaces.variables.create({
    parent: `accounts/${accountId}/containers/${containerId}/workspaces/${wsId}`,
    requestBody: variableBody,
  });
  return res.data;
}

async function updateVariable(auth, accountId, containerId, workspaceId, variableId, variableBody) {
  const gtm = getTagManager(auth);
  const wsId = await resolveWorkspaceId(auth, accountId, containerId, workspaceId);
  const res = await gtm.accounts.containers.workspaces.variables.update({
    path: `accounts/${accountId}/containers/${containerId}/workspaces/${wsId}/variables/${variableId}`,
    requestBody: variableBody,
  });
  return res.data;
}

async function deleteVariable(auth, accountId, containerId, workspaceId, variableId) {
  const gtm = getTagManager(auth);
  const wsId = await resolveWorkspaceId(auth, accountId, containerId, workspaceId);
  await gtm.accounts.containers.workspaces.variables.delete({
    path: `accounts/${accountId}/containers/${containerId}/workspaces/${wsId}/variables/${variableId}`,
  });
  return { deleted: true, variableId };
}

// ── PUBLISH ───────────────────────────────────────────────────────────────────

async function publishContainer(auth, accountId, containerId, workspaceId) {
  const gtm = getTagManager(auth);
  const wsId = await resolveWorkspaceId(auth, accountId, containerId, workspaceId);
  const versionRes = await gtm.accounts.containers.workspaces.create_version({
    path: `accounts/${accountId}/containers/${containerId}/workspaces/${wsId}`,
    requestBody: { name: `MCP publish ${new Date().toISOString()}` },
  });
  const versionId = versionRes.data.containerVersion.containerVersionId;
  const publishRes = await gtm.accounts.containers.versions.publish({
    path: `accounts/${accountId}/containers/${containerId}/versions/${versionId}`,
  });
  return publishRes.data;
}

module.exports = {
  listAccounts,
  listContainers,
  listWorkspaces,
  createWorkspace,
  listTemplates,
  listTags,
  createTag,
  updateTag,
  deleteTag,
  listTriggers,
  createTrigger,
  updateTrigger,
  deleteTrigger,
  listVariables,
  createVariable,
  updateVariable,
  deleteVariable,
  publishContainer,
};
