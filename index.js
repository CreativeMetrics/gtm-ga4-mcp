#!/usr/bin/env node

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const { getAuthClient, getAuthUrl, exchangeCode } = require('./src/auth.js');
const gtm = require('./src/gtm.js');
const ga4 = require('./src/ga4.js');
const { duplicateContainer } = require('./src/gtm-duplicate.js');
const { scanUrl } = require('./src/tag-detector.js');
const { createTagsFromUrl } = require('./src/gtm-from-scan.js');

const server = new Server(
  { name: 'gtm-ga4-mcp', version: '1.0.0' },
  { capabilities: { tools: {} }, timeout: 120000 }
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
      name: 'gtm_create_workspace',
      description: 'Crea un nuovo workspace GTM. Utile dopo una pubblicazione per iniziare un nuovo set di modifiche.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          container_id: { type: 'string' },
          name: { type: 'string', description: 'Nome del workspace (es. "Modifiche maggio 2025")' },
          description: { type: 'string', description: 'Descrizione opzionale' },
        },
        required: ['account_id', 'container_id', 'name'],
      },
    },
    {
      name: 'gtm_copy_template',
      description: 'Copia un singolo template da un container GTM a un altro per nome. Utile per installare un template specifico senza fare una duplicazione completa.',
      inputSchema: {
        type: 'object',
        properties: {
          src_account_id: { type: 'string' },
          src_container_id: { type: 'string' },
          src_workspace_id: { type: 'string', description: 'Opzionale' },
          template_name: { type: 'string', description: 'Nome esatto del template da copiare' },
          dst_account_id: { type: 'string' },
          dst_container_id: { type: 'string' },
          dst_workspace_id: { type: 'string', description: 'Opzionale' },
        },
        required: ['src_account_id', 'src_container_id', 'template_name', 'dst_account_id', 'dst_container_id'],
      },
    },
    {
      name: 'gtm_list_templates',
      description: 'Elenca i template installati in un workspace GTM, incluso il loro tipo (cvt_...) e templateId.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          container_id: { type: 'string' },
          workspace_id: { type: 'string', description: 'Opzionale' },
        },
        required: ['account_id', 'container_id'],
      },
    },
    // Tags
    {
      name: 'gtm_list_tags',
      description: 'Elenca i tag in un workspace GTM.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          container_id: { type: 'string' },
          workspace_id: { type: 'string', description: 'Opzionale' },
        },
        required: ['account_id', 'container_id'],
      },
    },
    {
      name: 'gtm_create_tag',
      description: 'Crea un nuovo tag in un workspace GTM.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          container_id: { type: 'string' },
          workspace_id: { type: 'string', description: 'Opzionale' },
          tag: { type: 'object', description: 'Oggetto tag GTM (name, type, parameter, firingTriggerId, ecc.)' },
        },
        required: ['account_id', 'container_id', 'tag'],
      },
    },
    {
      name: 'gtm_update_tag',
      description: 'Modifica un tag esistente in un workspace GTM.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          container_id: { type: 'string' },
          workspace_id: { type: 'string', description: 'Opzionale' },
          tag_id: { type: 'string', description: 'ID del tag da modificare' },
          tag: { type: 'object', description: 'Oggetto tag aggiornato' },
        },
        required: ['account_id', 'container_id', 'tag_id', 'tag'],
      },
    },
    {
      name: 'gtm_delete_tag',
      description: 'Elimina un tag da un workspace GTM.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          container_id: { type: 'string' },
          workspace_id: { type: 'string', description: 'Opzionale' },
          tag_id: { type: 'string', description: 'ID del tag da eliminare' },
        },
        required: ['account_id', 'container_id', 'tag_id'],
      },
    },

    // Triggers
    {
      name: 'gtm_list_triggers',
      description: 'Elenca i trigger in un workspace GTM.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          container_id: { type: 'string' },
          workspace_id: { type: 'string', description: 'Opzionale' },
        },
        required: ['account_id', 'container_id'],
      },
    },
    {
      name: 'gtm_create_trigger',
      description: 'Crea un nuovo trigger in un workspace GTM.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          container_id: { type: 'string' },
          workspace_id: { type: 'string', description: 'Opzionale' },
          trigger: { type: 'object', description: 'Oggetto trigger GTM (name, type, filter, ecc.)' },
        },
        required: ['account_id', 'container_id', 'trigger'],
      },
    },
    {
      name: 'gtm_update_trigger',
      description: 'Modifica un trigger esistente in un workspace GTM.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          container_id: { type: 'string' },
          workspace_id: { type: 'string', description: 'Opzionale' },
          trigger_id: { type: 'string', description: 'ID del trigger da modificare' },
          trigger: { type: 'object', description: 'Oggetto trigger aggiornato' },
        },
        required: ['account_id', 'container_id', 'trigger_id', 'trigger'],
      },
    },
    {
      name: 'gtm_delete_trigger',
      description: 'Elimina un trigger da un workspace GTM.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          container_id: { type: 'string' },
          workspace_id: { type: 'string', description: 'Opzionale' },
          trigger_id: { type: 'string', description: 'ID del trigger da eliminare' },
        },
        required: ['account_id', 'container_id', 'trigger_id'],
      },
    },

    // Variables
    {
      name: 'gtm_list_variables',
      description: 'Elenca le variabili in un workspace GTM.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          container_id: { type: 'string' },
          workspace_id: { type: 'string', description: 'Opzionale' },
        },
        required: ['account_id', 'container_id'],
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
          workspace_id: { type: 'string', description: 'Opzionale' },
          variable: { type: 'object', description: 'Oggetto variabile GTM (name, type, parameter, ecc.)' },
        },
        required: ['account_id', 'container_id', 'variable'],
      },
    },
    {
      name: 'gtm_update_variable',
      description: 'Modifica una variabile esistente in un workspace GTM.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          container_id: { type: 'string' },
          workspace_id: { type: 'string', description: 'Opzionale' },
          variable_id: { type: 'string', description: 'ID della variabile da modificare' },
          variable: { type: 'object', description: 'Oggetto variabile aggiornato' },
        },
        required: ['account_id', 'container_id', 'variable_id', 'variable'],
      },
    },
    {
      name: 'gtm_delete_variable',
      description: 'Elimina una variabile da un workspace GTM.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          container_id: { type: 'string' },
          workspace_id: { type: 'string', description: 'Opzionale' },
          variable_id: { type: 'string', description: 'ID della variabile da eliminare' },
        },
        required: ['account_id', 'container_id', 'variable_id'],
      },
    },
    {
      name: 'gtm_duplicate_container',
      description: 'Duplica un intero container GTM (tag, trigger, variabili, cartelle, template) in un altro container. Gestisce rate limiting, backoff automatico sui 429, remapping ID e installazione template.',
      inputSchema: {
        type: 'object',
        properties: {
          src_account_id: { type: 'string', description: 'Account ID del container sorgente' },
          src_container_id: { type: 'string', description: 'Container ID sorgente' },
          dst_account_id: { type: 'string', description: 'Account ID del container destinazione' },
          dst_container_id: { type: 'string', description: 'Container ID destinazione' },
          prefix: { type: 'string', description: 'Prefisso opzionale da aggiungere ai nomi (es. "[COPIA] ")' },
          suffix: { type: 'string', description: 'Suffisso opzionale da aggiungere ai nomi' },
        },
        required: ['src_account_id', 'src_container_id', 'dst_account_id', 'dst_container_id'],
      },
    },
    // User Permissions
    {
      name: 'gtm_list_users',
      description: 'Elenca tutti gli utenti con accesso a un account GTM e i loro permessi sui container.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
        },
        required: ['account_id'],
      },
    },
    {
      name: 'gtm_add_user',
      description: 'Aggiunge un utente a un account GTM con permessi specifici sui container.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          email: { type: 'string', description: 'Email Google dell\'utente' },
          account_permission: { type: 'string', enum: ['user', 'admin'], description: 'Permesso account (default: user)' },
          container_permissions: {
            type: 'array',
            description: 'Lista permessi per container',
            items: {
              type: 'object',
              properties: {
                containerId: { type: 'string' },
                permission: { type: 'string', enum: ['no_access', 'read', 'edit', 'approve', 'publish'] },
              },
            },
          },
        },
        required: ['account_id', 'email'],
      },
    },
    {
      name: 'gtm_update_user',
      description: 'Modifica i permessi di un utente esistente su un account GTM.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          user_permission_id: { type: 'string', description: 'ID permesso utente (da gtm_list_users)' },
          account_permission: { type: 'string', enum: ['user', 'admin'] },
          container_permissions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                containerId: { type: 'string' },
                permission: { type: 'string', enum: ['no_access', 'read', 'edit', 'approve', 'publish'] },
              },
            },
          },
        },
        required: ['account_id', 'user_permission_id'],
      },
    },
    {
      name: 'gtm_remove_user',
      description: 'Rimuove completamente l\'accesso di un utente a un account GTM.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string' },
          user_permission_id: { type: 'string', description: 'ID permesso utente (da gtm_list_users)' },
        },
        required: ['account_id', 'user_permission_id'],
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
          workspace_id: { type: 'string', description: 'Opzionale — se omesso usa il Default Workspace' },
        },
        required: ['account_id', 'container_id'],
      },
    },

    // Tag Detection
    {
      name: 'scan_url',
      description: 'Scansiona un URL con un browser reale e rileva tutti i tag attivi (analytics, advertising, CMP, live chat, ecc.) tramite analisi di rete, HTML e variabili JavaScript. Accetta automaticamente i cookie banner.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL del sito da analizzare (es. https://www.esempio.it)' },
        },
        required: ['url'],
      },
    },
    {
      name: 'create_tags_from_url',
      description: 'Scansiona un URL, rileva i tag attivi, estrae gli ID configurati e crea automaticamente i tag corrispondenti in un nuovo workspace GTM. Usa template nativi per GA4/Google Ads e template gallery ufficiali per Meta (Stape), LinkedIn, Clarity, TikTok, Pinterest.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL del sito da analizzare' },
          account_id: { type: 'string' },
          container_id: { type: 'string' },
        },
        required: ['url', 'account_id', 'container_id'],
      },
    },
    {
      name: 'compare_url_with_container',
      description: 'Scansiona un URL e confronta i tag rilevati con quelli configurati in un container GTM. Identifica tag attivi sul sito, tag in GTM non rilevati sul sito, e tag sul sito non in GTM.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL del sito da analizzare' },
          account_id: { type: 'string' },
          container_id: { type: 'string' },
          workspace_id: { type: 'string', description: 'Opzionale' },
        },
        required: ['url', 'account_id', 'container_id'],
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
      case 'gtm_copy_template':
        result = await gtm.copyTemplate(
          auth,
          args.src_account_id, args.src_container_id, args.src_workspace_id,
          args.template_name,
          args.dst_account_id, args.dst_container_id, args.dst_workspace_id
        );
        break;
      case 'gtm_list_templates':
        result = await gtm.listTemplates(auth, args.account_id, args.container_id, args.workspace_id);
        break;
      case 'gtm_list_accounts':
        result = await gtm.listAccounts(auth);
        break;
      case 'gtm_list_containers':
        result = await gtm.listContainers(auth, args.account_id);
        break;
      case 'gtm_create_workspace':
        result = await gtm.createWorkspace(auth, args.account_id, args.container_id, args.name, args.description);
        break;
      case 'gtm_list_tags':
        result = await gtm.listTags(auth, args.account_id, args.container_id, args.workspace_id);
        break;
      case 'gtm_create_tag':
        result = await gtm.createTag(auth, args.account_id, args.container_id, args.workspace_id, args.tag);
        break;
      case 'gtm_update_tag':
        result = await gtm.updateTag(auth, args.account_id, args.container_id, args.workspace_id, args.tag_id, args.tag);
        break;
      case 'gtm_delete_tag':
        result = await gtm.deleteTag(auth, args.account_id, args.container_id, args.workspace_id, args.tag_id);
        break;
      case 'gtm_list_triggers':
        result = await gtm.listTriggers(auth, args.account_id, args.container_id, args.workspace_id);
        break;
      case 'gtm_create_trigger':
        result = await gtm.createTrigger(auth, args.account_id, args.container_id, args.workspace_id, args.trigger);
        break;
      case 'gtm_update_trigger':
        result = await gtm.updateTrigger(auth, args.account_id, args.container_id, args.workspace_id, args.trigger_id, args.trigger);
        break;
      case 'gtm_delete_trigger':
        result = await gtm.deleteTrigger(auth, args.account_id, args.container_id, args.workspace_id, args.trigger_id);
        break;
      case 'gtm_list_variables':
        result = await gtm.listVariables(auth, args.account_id, args.container_id, args.workspace_id);
        break;
      case 'gtm_create_variable':
        result = await gtm.createVariable(auth, args.account_id, args.container_id, args.workspace_id, args.variable);
        break;
      case 'gtm_update_variable':
        result = await gtm.updateVariable(auth, args.account_id, args.container_id, args.workspace_id, args.variable_id, args.variable);
        break;
      case 'gtm_delete_variable':
        result = await gtm.deleteVariable(auth, args.account_id, args.container_id, args.workspace_id, args.variable_id);
        break;
      case 'gtm_duplicate_container':
        result = await duplicateContainer(
          auth,
          args.src_account_id, args.src_container_id,
          args.dst_account_id, args.dst_container_id,
          { prefix: args.prefix, suffix: args.suffix }
        );
        break;
      case 'gtm_publish_container':
        result = await gtm.publishContainer(auth, args.account_id, args.container_id, args.workspace_id);
        break;
      case 'gtm_list_users':
        result = await gtm.listUsers(auth, args.account_id);
        break;
      case 'gtm_add_user':
        result = await gtm.addUser(auth, args.account_id, args.email, args.account_permission, args.container_permissions);
        break;
      case 'gtm_update_user':
        result = await gtm.updateUser(auth, args.account_id, args.user_permission_id, args.account_permission, args.container_permissions);
        break;
      case 'gtm_remove_user':
        result = await gtm.removeUser(auth, args.account_id, args.user_permission_id);
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

      // Tag Detection
      case 'create_tags_from_url':
        result = await createTagsFromUrl(auth, args.url, args.account_id, args.container_id);
        break;
      case 'scan_url':
        result = await scanUrl(args.url);
        break;
      case 'compare_url_with_container': {
        const [scanResult, gtmTags] = await Promise.all([
          scanUrl(args.url),
          gtm.listTags(auth, args.account_id, args.container_id, args.workspace_id),
        ]);
        const detectedNames = new Set(scanResult.tags.map(t => t.name.toLowerCase()));
        const gtmTagTypes = gtmTags.map(t => t.type || '');
        // Map well-known GTM tag types to detected tag names
        const GTM_TYPE_MAP = {
          'ua':         'Google Analytics Universal (UA)',
          'googtag':    'Google Analytics 4 (GA4)',
          'ga4':        'Google Analytics 4 (GA4)',
          'awct':       'Google Ads / Conversion',
          'sp':         'Snapchat Pixel',
          'fls':        'DoubleClick / Campaign Manager',
          'html':       null,
          'img':        null,
        };
        const gtmTagsSummary = gtmTags.map(t => ({
          name: t.name,
          type: t.type,
          paused: t.paused || false,
        }));
        result = {
          url: scanResult.url,
          elapsed_ms: scanResult.elapsed_ms,
          cookie_banner_accepted: scanResult.cookie_banner_accepted,
          detected_on_site: scanResult.tags,
          gtm_tags_count: gtmTags.length,
          gtm_tags: gtmTagsSummary,
          summary: {
            tags_on_site: scanResult.tags_found,
            tags_in_gtm: gtmTags.length,
            note: 'Il confronto diretto tra tag GTM e tag rilevati è approssimativo perché i tag GTM usano tipi tecnici (es. "ua", "googtag") mentre il detector usa nomi commerciali.',
          },
        };
        break;
      }

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
