const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const CREDENTIALS_PATH = path.join(process.env.HOME, '.gtm-ga4-mcp', 'credentials.json');
const TOKEN_PATH = path.join(process.env.HOME, '.gtm-ga4-mcp', 'token.json');

const SCOPES = [
  'https://www.googleapis.com/auth/tagmanager.manage.accounts',
  'https://www.googleapis.com/auth/tagmanager.manage.users',
  'https://www.googleapis.com/auth/tagmanager.edit.containers',
  'https://www.googleapis.com/auth/tagmanager.publish',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/analytics.edit',
  'https://www.googleapis.com/auth/webmasters.readonly',
];

function getAuthClient() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Credenziali non trovate. Copia il tuo credentials.json in: ${CREDENTIALS_PATH}`
    );
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_secret, client_id } = credentials.installed || credentials.web;

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, 'urn:ietf:wg:oauth:2.0:oob');

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oAuth2Client.setCredentials(token);
  }

  return oAuth2Client;
}

function getAuthUrl(oAuth2Client) {
  return oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
  });
}

async function exchangeCode(oAuth2Client, code) {
  const { tokens } = await oAuth2Client.getToken({ code, redirect_uri: 'urn:ietf:wg:oauth:2.0:oob' });
  oAuth2Client.setCredentials(tokens);

  const dir = path.dirname(TOKEN_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));

  return tokens;
}

module.exports = { getAuthClient, getAuthUrl, exchangeCode };
