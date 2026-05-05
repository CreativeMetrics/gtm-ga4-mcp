# GTM & GA4 MCP Server

MCP (Model Context Protocol) server per gestire Google Tag Manager e Google Analytics 4 direttamente da Claude.

## Tool disponibili

### Autenticazione
| Tool | Descrizione |
|------|-------------|
| `get_auth_url` | Genera il link OAuth2 per il primo accesso |
| `exchange_auth_code` | Completa il login con il codice Google |

### Google Tag Manager
| Tool | Descrizione |
|------|-------------|
| `gtm_list_accounts` | Elenca gli account GTM |
| `gtm_list_containers` | Elenca i container di un account |
| `gtm_list_tags` | Elenca i tag in un workspace |
| `gtm_list_triggers` | Elenca i trigger in un workspace |
| `gtm_list_variables` | Elenca le variabili in un workspace |
| `gtm_create_variable` | Crea una nuova variabile |
| `gtm_publish_container` | Pubblica il workspace (crea versione) |

### Google Analytics 4
| Tool | Descrizione |
|------|-------------|
| `ga4_list_properties` | Elenca le proprietà GA4 |
| `ga4_list_custom_dimensions` | Elenca le custom dimension |
| `ga4_create_custom_dimension` | Crea una custom dimension |
| `ga4_duplicate_custom_dimensions` | Duplica le custom dimension tra proprietà |
| `ga4_list_custom_metrics` | Elenca le custom metric |
| `ga4_run_report` | Esegue un report personalizzato |
| `ga4_list_conversion_events` | Elenca gli eventi di conversione |

## Setup

### 1. Credenziali Google Cloud

1. Vai su [Google Cloud Console](https://console.cloud.google.com/)
2. Crea un nuovo progetto (o usa uno esistente)
3. Abilita le API:
   - **Tag Manager API**
   - **Google Analytics Admin API**
   - **Google Analytics Data API**
4. Vai su **API & Services → Credentials**
5. Crea **OAuth 2.0 Client ID** → tipo **Desktop app**
6. Scarica il file JSON e salvalo in:

```
~/.gtm-ga4-mcp/credentials.json
```

### 2. Installazione

```bash
git clone https://github.com/TUO_USERNAME/gtm-ga4-mcp.git
cd gtm-ga4-mcp
npm install
```

### 3. Configurazione Claude Desktop

Aggiungi in `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gtm-ga4": {
      "command": "node",
      "args": ["/percorso/assoluto/gtm-ga4-mcp/index.js"]
    }
  }
}
```

### 4. Primo accesso

Al primo utilizzo, chiedi a Claude:
1. *"Genera il link di autenticazione GTM/GA4"* → apri il link nel browser
2. Dopo l'autorizzazione, Google ti darà un codice
3. *"Completa il login con il codice: XXXXX"*

Il token viene salvato in `~/.gtm-ga4-mcp/token.json` e riutilizzato automaticamente.

## Esempi d'uso

```
"Elenca tutti i miei account GTM"
"Mostra i tag nel container 123 workspace 1"
"Quante sessioni ho avuto negli ultimi 7 giorni sulla proprietà 456?"
"Duplica le custom dimension dalla proprietà 111 alla proprietà 222"
"Crea una custom dimension 'user_type' di tipo EVENT nella proprietà 456"
```
