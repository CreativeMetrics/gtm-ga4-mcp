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

async function listTags(auth, accountId, containerId, workspaceId) {
  const gtm = getTagManager(auth);
  const res = await gtm.accounts.containers.workspaces.tags.list({
    parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
  });
  return res.data.tag || [];
}

async function listTriggers(auth, accountId, containerId, workspaceId) {
  const gtm = getTagManager(auth);
  const res = await gtm.accounts.containers.workspaces.triggers.list({
    parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
  });
  return res.data.trigger || [];
}

async function listVariables(auth, accountId, containerId, workspaceId) {
  const gtm = getTagManager(auth);
  const res = await gtm.accounts.containers.workspaces.variables.list({
    parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
  });
  return res.data.variable || [];
}

async function createVariable(auth, accountId, containerId, workspaceId, variableBody) {
  const gtm = getTagManager(auth);
  const res = await gtm.accounts.containers.workspaces.variables.create({
    parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
    requestBody: variableBody,
  });
  return res.data;
}

async function publishContainer(auth, accountId, containerId, workspaceId) {
  const gtm = getTagManager(auth);
  // Create a version first
  const versionRes = await gtm.accounts.containers.workspaces.create_version({
    path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
    requestBody: { name: `MCP publish ${new Date().toISOString()}` },
  });
  const versionId = versionRes.data.containerVersion.containerVersionId;

  // Then publish
  const publishRes = await gtm.accounts.containers.versions.publish({
    path: `accounts/${accountId}/containers/${containerId}/versions/${versionId}`,
  });
  return publishRes.data;
}

module.exports = {
  listAccounts,
  listContainers,
  listWorkspaces,
  listTags,
  listTriggers,
  listVariables,
  createVariable,
  publishContainer,
};
