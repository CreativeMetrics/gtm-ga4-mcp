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

## Le API sono a pagamento?

No. Tag Manager API, Google Analytics Admin API e Analytics Data API sono **completamente gratuite**. Google richiede un progetto Cloud con carta di credito associata, ma non addebita nulla per queste API.

## Setup

### 1. Crea il progetto Google Cloud

1. Vai su [console.cloud.google.com](https://console.cloud.google.com)
2. **New Project** → dai un nome (es. `gtm-ga4-mcp`)

### 2. Abilita le 3 API

Da **APIs & Services → Library**, cerca e abilita:
- `Tag Manager API`
- `Google Analytics Admin API`
- `Google Analytics Data API`

### 3. Configura la OAuth consent screen

1. Vai su **APIs & Services → OAuth consent screen**
2. User type: **External**
3. Compila nome app ed email
4. Nella sezione **Test users** aggiungi la tua email Google

> Finché l'app è in modalità "Testing" puoi usarla liberamente senza pubblicarla.

### 4. Crea le credenziali OAuth

1. **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
2. Application type: **Desktop app**
3. Scarica il JSON e salvalo in:

```
~/.gtm-ga4-mcp/credentials.json
```

### 5. Installazione

```bash
git clone https://github.com/CreativeMetrics/gtm-ga4-mcp.git
cd gtm-ga4-mcp
npm install
```

### 6. Configurazione Claude Desktop

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

Riavvia Claude Desktop dopo aver salvato il file.

### 7. Primo accesso

Al primo utilizzo, chiedi a Claude:
1. *"Genera il link di autenticazione GTM/GA4"* → apri il link nel browser
2. Accedi con il tuo account Google e autorizza l'app
3. Google mostrerà un codice **direttamente a schermo** — copialo
4. *"Completa il login con il codice: XXXXX"*

Il token viene salvato in `~/.gtm-ga4-mcp/token.json` e riutilizzato automaticamente nelle sessioni successive.

## Esempi d'uso

```
"Elenca tutti i miei account GTM"
"Mostra i tag nel container 123 workspace 1"
"Quante sessioni ho avuto negli ultimi 7 giorni sulla proprietà 456?"
"Duplica le custom dimension dalla proprietà 111 alla proprietà 222"
"Crea una custom dimension 'user_type' di tipo EVENT nella proprietà 456"
```
