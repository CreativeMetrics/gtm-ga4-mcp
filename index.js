#!/usr/bin/env node

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const { getAuthClient, getAuthUrl, exchangeCode } = require('./src/auth.js');
const gtm = require('./src/gtm.js');
const ga4 = require('./src/ga4.js');

const server = new Server(
  { name: 'gtm-ga4-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // Auth
    {
      name: 'get_auth_url',
      description: 'Genera il link di autorizzazione OAuth2 per Google. Da usare al primo avvio.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'exchange_auth_code',
      description: 'Completa il login scambiando il codice OAuth con un token di accesso.',
      inputSchema: {
        type: 'object',
        properties: { code: { type: 'string', description: 'Codice ricevuto da Google dopo il login' } },
        required: ['code'],
      },
    },

    // GTM
    {
      name: 'gtm_list_accounts',
      description: 'Elenca tutti gli account Google Tag Manager accessibili.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'gtm_list_containers',
      description: 'Elenca i container GTM di un account.',
      inputSchema: {
        type: 'object',
        properties: { account_id: { type: 'string', description: 'ID account GTM' } },
        required: ['account_id'],
      },
    },
    {
      name: 'gtm_list_tags',
      description: 'Elenca i tag in un workspace GTM.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          container_id: { type: 'string' },
          workspace_id: { type: 'string' },
        },
        required: ['account_id', 'container_id', 'workspace_id'],
      },
    },
    {
      name: 'gtm_list_triggers',
      description: 'Elenca i trigger in un workspace GTM.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          container_id: { type: 'string' },
          workspace_id: { type: 'string' },
        },
        required: ['account_id', 'container_id', 'workspace_id'],
      },
    },
    {
      name: 'gtm_list_variables',
      description: 'Elenca le variabili in un workspace GTM.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          container_id: { type: 'string' },
          workspace_id: { type: 'string' },
        },
        required: ['account_id', 'container_id', 'workspace_id'],
      },
    },
    {
      name: 'gtm_create_variable',
      description: 'Crea una nuova variabile in un workspace GTM.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          container_id: { type: 'string' },
          workspace_id: { type: 'string' },
          variable: {
            type: 'object',
            description: 'Oggetto variabile GTM (name, type, parameter, ecc.)',
          },
        },
        required: ['account_id', 'container_id', 'workspace_id', 'variable'],
      },
    },
    {
      name: 'gtm_publish_container',
      description: 'Pubblica il workspace GTM corrente creando una nuova versione.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          container_id: { type: 'string' },
          workspace_id: { type: 'string' },
        },
        required: ['account_id', 'container_id', 'workspace_id'],
      },
    },

    // GA4
    {
      name: 'ga4_list_properties',
      description: 'Elenca tutte le proprietà GA4 accessibili.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ga4_list_custom_dimensions',
      description: 'Elenca le custom dimension di una proprietà GA4.',
      inputSchema: {
        type: 'object',
        properties: { property_id: { type: 'string', description: 'ID proprietà GA4 (solo numero)' } },
        required: ['property_id'],
      },
    },
    {
      name: 'ga4_create_custom_dimension',
      description: 'Crea una custom dimension in una proprietà GA4.',
      inputSchema: {
        type: 'object',
        properties: {
          property_id: { type: 'string' },
          display_name: { type: 'string' },
          parameter_name: { type: 'string' },
          scope: { type: 'string', enum: ['EVENT', 'USER', 'ITEM'] },
          description: { type: 'string' },
        },
        required: ['property_id', 'display_name', 'parameter_name', 'scope'],
      },
    },
    {
      name: 'ga4_duplicate_custom_dimensions',
      description: 'Duplica tutte le custom dimension da una proprietà GA4 a un\'altra.',
      inputSchema: {
        type: 'object',
        properties: {
          source_property_id: { type: 'string' },
          target_property_id: { type: 'string' },
        },
        required: ['source_property_id', 'target_property_id'],
      },
    },
    {
      name: 'ga4_list_custom_metrics',
      description: 'Elenca le custom metric di una proprietà GA4.',
      inputSchema: {
        type: 'object',
        properties: { property_id: { type: 'string' } },
        required: ['property_id'],
      },
    },
    {
      name: 'ga4_run_report',
      description: 'Esegue un report GA4 con metriche e dimensioni personalizzate.',
      inputSchema: {
        type: 'object',
        properties: {
          property_id: { type: 'string' },
          metrics: { type: 'array', items: { type: 'string' }, description: 'Es. ["sessions", "activeUsers"]' },
          dimensions: { type: 'array', items: { type: 'string' }, description: 'Es. ["date", "deviceCategory"]' },
          start_date: { type: 'string', description: 'Es. "7daysAgo" o "2024-01-01"' },
          end_date: { type: 'string', description: 'Es. "today"' },
          limit: { type: 'number', description: 'Numero di righe (default 10)' },
        },
        required: ['property_id', 'metrics', 'dimensions', 'start_date', 'end_date'],
      },
    },
    {
      name: 'ga4_list_conversion_events',
      description: 'Elenca gli eventi di conversione configurati in una proprietà GA4.',
      inputSchema: {
        type: 'object',
        properties: { property_id: { type: 'string' } },
        required: ['property_id'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let auth;
    if (name !== 'get_auth_url' && name !== 'exchange_auth_code') {
      auth = getAuthClient();
    }

    let result;

    switch (name) {
      case 'get_auth_url': {
        const client = getAuthClient();
        const url = getAuthUrl(client);
        result = `Apri questo URL nel browser per autorizzare l'accesso:\n\n${url}`;
        break;
      }
      case 'exchange_auth_code': {
        const client = getAuthClient();
        await exchangeCode(client, args.code);
        result = 'Autenticazione completata! Il token è stato salvato.';
        break;
      }

      // GTM
      case 'gtm_list_accounts':
        result = await gtm.listAccounts(auth);
        break;
      case 'gtm_list_containers':
        result = await gtm.listContainers(auth, args.account_id);
        break;
      case 'gtm_list_tags':
        result = await gtm.listTags(auth, args.account_id, args.container_id, args.workspace_id);
        break;
      case 'gtm_list_triggers':
        result = await gtm.listTriggers(auth, args.account_id, args.container_id, args.workspace_id);
        break;
      case 'gtm_list_variables':
        result = await gtm.listVariables(auth, args.account_id, args.container_id, args.workspace_id);
        break;
      case 'gtm_create_variable':
        result = await gtm.createVariable(auth, args.account_id, args.container_id, args.workspace_id, args.variable);
        break;
      case 'gtm_publish_container':
        result = await gtm.publishContainer(auth, args.account_id, args.container_id, args.workspace_id);
        break;

      // GA4
      case 'ga4_list_properties':
        result = await ga4.listProperties(auth);
        break;
      case 'ga4_list_custom_dimensions':
        result = await ga4.listCustomDimensions(auth, args.property_id);
        break;
      case 'ga4_create_custom_dimension':
        result = await ga4.createCustomDimension(auth, args.property_id, {
          displayName: args.display_name,
          parameterName: args.parameter_name,
          scope: args.scope,
          description: args.description || '',
        });
        break;
      case 'ga4_duplicate_custom_dimensions':
        result = await ga4.duplicateCustomDimensions(auth, args.source_property_id, args.target_property_id);
        break;
      case 'ga4_list_custom_metrics':
        result = await ga4.listCustomMetrics(auth, args.property_id);
        break;
      case 'ga4_run_report':
        result = await ga4.runReport(auth, args.property_id, {
          metrics: args.metrics,
          dimensions: args.dimensions,
          dateRanges: [{ startDate: args.start_date, endDate: args.end_date }],
          limit: args.limit || 10,
        });
        break;
      case 'ga4_list_conversion_events':
        result = await ga4.listConversionEvents(auth, args.property_id);
        break;

      default:
        throw new Error(`Tool sconosciuto: ${name}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Errore: ${error.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('GTM & GA4 MCP Server avviato');
}

main().catch(console.error);
