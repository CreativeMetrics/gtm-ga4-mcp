const puppeteer = require('puppeteer');

// ── Tag signatures (ported from tag-detector standalone script) ───────────────
const TAG_SIGNATURES = [
  // Tag Management
  { name: 'Google Tag Manager', category: 'Tag Management', patterns: { urls: [/googletagmanager\.com\/gtm\.js/i], html: [/GTM-[A-Z0-9]{4,}/i, /googletagmanager\.com\/gtm\.js/i], jsVars: ['google_tag_manager'] } },
  { name: 'Adobe Launch (DTM)', category: 'Tag Management', patterns: { urls: [/assets\.adobedtm\.com/i], html: [/adobedtm\.com/i, /satelliteLib/i], jsVars: ['_satellite'] } },
  { name: 'Tealium', category: 'Tag Management', patterns: { urls: [/tags\.tiqcdn\.com/i, /collect\.tealiumiq\.com/i], html: [/tiqcdn\.com/i], jsVars: ['utag', 'utag_data'] } },
  { name: 'Stape (Server-side GTM)', category: 'Tag Management', patterns: { urls: [/stape\.io/i], html: [/stape\.io/i], jsVars: [] } },
  // Analytics
  { name: 'Google Analytics 4 (GA4)', category: 'Analytics', patterns: { urls: [/google-analytics\.com\/g\/collect/i, /analytics\.google\.com/i], html: [/gtag\('config',\s*['"]G-/i, /G-[A-Z0-9]{8,}/i], jsVars: [] } },
  { name: 'Google Analytics Universal (UA)', category: 'Analytics', patterns: { urls: [/google-analytics\.com\/analytics\.js/i, /google-analytics\.com\/collect/i], html: [/UA-\d{4,}-\d+/i, /google-analytics\.com\/analytics\.js/i], jsVars: ['_gaq'] } },
  { name: 'Adobe Analytics', category: 'Analytics', patterns: { urls: [/omtrdc\.net/i, /2o7\.net/i], html: [/omtrdc\.net/i, /s_gi\s*\(/i, /AppMeasurement/i], jsVars: ['s_gi', 'AppMeasurement'] } },
  { name: 'Microsoft Clarity', category: 'Analytics', patterns: { urls: [/clarity\.ms\/collect/i, /clarity\.ms\/tag/i], html: [/clarity\.ms/i], jsVars: ['clarity'] } },
  { name: 'Matomo (Piwik)', category: 'Analytics', patterns: { urls: [/matomo\.js/i, /piwik\.js/i, /matomo\.php/i, /piwik\.php/i], html: [/matomo\.js/i, /piwik\.js/i, /_paq\.push/i], jsVars: ['_paq', 'Matomo'] } },
  { name: 'Mixpanel', category: 'Analytics', patterns: { urls: [/cdn\.mxpnl\.com/i, /api\.mixpanel\.com/i], html: [/mxpnl\.com/i, /mixpanel\.init\s*\(/i], jsVars: [], jsChecks: [{ label: 'window.mixpanel', expr: `typeof window.mixpanel === 'object' && typeof window.mixpanel.track === 'function' && typeof window.mixpanel.identify === 'function'` }] } },
  { name: 'Amplitude', category: 'Analytics', patterns: { urls: [/cdn\.amplitude\.com/i, /api\.amplitude\.com/i], html: [/amplitude\.com\/libs/i, /amplitude\.getInstance/i], jsVars: ['amplitude'] } },
  { name: 'Hotjar', category: 'Analytics', patterns: { urls: [/static\.hotjar\.com/i, /vc\.hotjar\.io/i], html: [/static\.hotjar\.com/i, /hjid\s*:/i], jsVars: ['_hjSettings'] } },
  { name: 'Contentsquare', category: 'Analytics', patterns: { urls: [/t\.contentsquare\.net/i, /sstatic\.contentsquare\.net/i], html: [/contentsquare\.net/i], jsVars: ['_uxa', 'CS_CONF'] } },
  { name: 'Crazy Egg', category: 'Analytics', patterns: { urls: [/script\.crazyegg\.com/i], html: [/crazyegg\.com/i], jsVars: ['CE2'] } },
  { name: 'Yandex Metrica', category: 'Analytics', patterns: { urls: [/mc\.yandex\.ru\/metrika/i, /mc\.yandex\.com\/metrika/i], html: [/mc\.yandex\.ru\/metrika/i], jsVars: [], jsChecks: [{ label: 'window.ym (Yandex Metrica)', expr: `typeof window.ym === 'function' && Object.keys(window).some(k => /^yaCounter\\d+$/.test(k))` }] } },
  // Session Recording
  { name: 'FullStory', category: 'Session Recording', patterns: { urls: [/fullstory\.com\/s\/fs\.js/i, /rs\.fullstory\.com/i], html: [/fullstory\.com\/s\/fs/i], jsVars: ['_fs_namespace'] } },
  { name: 'Mouseflow', category: 'Session Recording', patterns: { urls: [/mouseflow\.com\/deploy/i, /cdn\.mouseflow\.com/i], html: [/mouseflow\.com\/deploy/i], jsVars: ['mouseflow', '_mfq'] } },
  { name: 'Lucky Orange', category: 'Session Recording', patterns: { urls: [/luckyorange\.com\/li\.js/i, /luckyorange\.net/i], html: [/luckyorange\.com/i], jsVars: ['_loq'] } },
  { name: 'Smartlook', category: 'Session Recording', patterns: { urls: [/rec\.smartlook\.com/i, /web-sdk\.smartlook\.com/i], html: [/smartlook\.init\s*\(/i], jsVars: ['smartlook'] } },
  // A/B Testing
  { name: 'VWO (Visual Website Optimizer)', category: 'A/B Testing', patterns: { urls: [/dev\.visualwebsiteoptimizer\.com/i, /app\.vwo\.com/i], html: [/visualwebsiteoptimizer\.com/i, /vwo_code/i], jsVars: ['_vwo_code', 'VWO'] } },
  { name: 'AB Tasty', category: 'A/B Testing', patterns: { urls: [/try\.abtasty\.com/i], html: [/abtasty\.com/i, /ABTasty/i], jsVars: ['ABTasty', 'ABTastyData'] } },
  { name: 'Kameleoon', category: 'A/B Testing', patterns: { urls: [/kameleoon\.eu\/kameleoon\.js/i], html: [/kameleoon\.eu/i], jsVars: ['Kameleoon', 'kameleoon'] } },
  { name: 'Optimizely', category: 'A/B Testing', patterns: { urls: [/cdn\.optimizely\.com/i], html: [/cdn\.optimizely\.com/i], jsVars: ['optimizely'] } },
  // Advertising
  { name: 'Meta (Facebook) Pixel', category: 'Advertising', patterns: { urls: [/connect\.facebook\.net\/.*\/fbevents\.js/i, /facebook\.com\/tr\//i], html: [/connect\.facebook\.net\/.*fbevents/i, /fbq\('init'/i], jsVars: ['fbq', '_fbq'] } },
  { name: 'Google Ads / Conversion', category: 'Advertising', patterns: { urls: [/googleadservices\.com\/pagead/i, /googlesyndication\.com/i], html: [/AW-\d{9,}/i, /googleadservices\.com/i], jsVars: [] } },
  { name: 'DoubleClick / Campaign Manager', category: 'Advertising', patterns: { urls: [/stats\.g\.doubleclick\.net/i, /ad\.doubleclick\.net/i], html: [], jsVars: [] } },
  { name: 'Microsoft Bing Ads (UET)', category: 'Advertising', patterns: { urls: [/bat\.bing\.com/i, /bat\.r\.msn\.com/i], html: [/bat\.bing\.com/i, /uetq\s*=/i], jsVars: ['uetq'] } },
  { name: 'Criteo', category: 'Advertising', patterns: { urls: [/static\.criteo\.net/i, /gum\.criteo\.com/i], html: [/static\.criteo\.net/i], jsVars: ['CriteoQ'] } },
  { name: 'LinkedIn Insight Tag', category: 'Advertising', patterns: { urls: [/snap\.licdn\.com\/li\.lms-analytics/i, /px\.ads\.linkedin\.com/i], html: [/snap\.licdn\.com/i], jsVars: ['_linkedin_data_partner_id', 'lintrk'] } },
  { name: 'TikTok Pixel', category: 'Advertising', patterns: { urls: [/analytics\.tiktok\.com/i, /static\.ads-api\.tiktok\.com/i], html: [/analytics\.tiktok\.com/i, /ttq\.load\s*\(/i], jsVars: ['ttq', 'TiktokAnalyticsObject'] } },
  { name: 'X (Twitter) Pixel', category: 'Advertising', patterns: { urls: [/analytics\.twitter\.com/i, /static\.ads-twitter\.com/i], html: [/static\.ads-twitter\.com/i, /twq\('init'/i], jsVars: ['twq'] } },
  { name: 'Pinterest Tag', category: 'Advertising', patterns: { urls: [/ct\.pinterest\.com/i], html: [/pintrk\s*\(/i], jsVars: ['pintrk'] } },
  { name: 'Snapchat Pixel', category: 'Advertising', patterns: { urls: [/tr\.snapchat\.com/i], html: [/sc-static\.net\/scevent/i, /snaptr\s*\(/i], jsVars: ['snaptr'] } },
  { name: 'TikTok Pixel', category: 'Advertising', patterns: { urls: [/analytics\.tiktok\.com/i], html: [/ttq\.load\s*\(/i], jsVars: ['ttq'] } },
  { name: 'Taboola', category: 'Advertising', patterns: { urls: [/trc\.taboola\.com/i, /cdn\.taboola\.com/i], html: [/window\._taboola/i], jsVars: ['_taboola'] } },
  { name: 'Outbrain', category: 'Advertising', patterns: { urls: [/amplify\.outbrain\.com/i, /tr\.outbrain\.com/i], html: [/OBR\.extern/i], jsVars: [] } },
  { name: 'AdRoll', category: 'Advertising', patterns: { urls: [/d\.adroll\.com/i], html: [/adroll_adv_id/i], jsVars: ['__adroll'] } },
  { name: 'The Trade Desk (TTD)', category: 'Advertising', patterns: { urls: [/insight\.adsrvr\.org/i], html: [/adsrvr\.org/i, /TTDUniversalPixelApi/i], jsVars: ['TTDUniversalPixelApi'] } },
  // CDP / Marketing Automation
  { name: 'Segment', category: 'CDP', patterns: { urls: [/cdn\.segment\.com/i, /api\.segment\.io/i], html: [/cdn\.segment\.com/i, /analytics\.load\s*\(/i], jsVars: [], jsChecks: [{ label: 'window.analytics (Segment)', expr: `typeof window.analytics === 'object' && typeof window.analytics.track === 'function' && typeof window.analytics.identify === 'function' && typeof window.analytics.page === 'function'` }] } },
  { name: 'HubSpot', category: 'Marketing Automation', patterns: { urls: [/js\.hs-scripts\.com/i, /js\.hubspot\.com/i], html: [/hs-scripts\.com/i], jsVars: ['_hsq', 'HubSpotConversations'] } },
  { name: 'Salesforce Pardot', category: 'Marketing Automation', patterns: { urls: [/pi\.pardot\.com/i], html: [/piTracker/i], jsVars: ['piTracker', 'piAId'] } },
  { name: 'Klaviyo', category: 'Marketing Automation', patterns: { urls: [/static\.klaviyo\.com/i, /a\.klaviyo\.com/i], html: [/klaviyo\.com/i], jsVars: ['_learnq'] } },
  { name: 'Brevo (Sendinblue)', category: 'Marketing Automation', patterns: { urls: [/sibautomation\.com/i], html: [/sibautomation\.com/i], jsVars: [] } },
  { name: 'Mailchimp', category: 'Marketing Automation', patterns: { urls: [/chimpstatic\.com/i, /list-manage\.com/i], html: [/chimpstatic\.com/i], jsVars: [] } },
  // Customer Support / Live Chat
  { name: 'Intercom', category: 'Customer Support', patterns: { urls: [/widget\.intercom\.io/i, /js\.intercomcdn\.com/i], html: [/intercomcdn\.com/i], jsVars: [], jsChecks: [{ label: 'window.Intercom', expr: `typeof window.Intercom === 'function' && typeof window.intercomSettings === 'object' && window.intercomSettings !== null` }] } },
  { name: 'Zendesk', category: 'Customer Support', patterns: { urls: [/ekr\.zdassets\.com/i, /static\.zdassets\.com/i], html: [/zdassets\.com/i], jsVars: ['zE', 'zESettings'] } },
  { name: 'Drift', category: 'Live Chat', patterns: { urls: [/js\.driftt\.com/i], html: [/driftt\.com/i], jsVars: ['drift', 'driftt'] } },
  { name: 'Tawk.to', category: 'Live Chat', patterns: { urls: [/embed\.tawk\.to/i], html: [/tawk\.to/i, /Tawk_API/i], jsVars: ['Tawk_API'] } },
  { name: 'Tidio', category: 'Live Chat', patterns: { urls: [/code\.tidio\.co/i], html: [/tidio\.co/i], jsVars: ['tidioChatApi'] } },
  // Consent Management
  { name: 'Cookiebot (CMP)', category: 'Consent Management', patterns: { urls: [/consent\.cookiebot\.com/i], html: [/cookiebot\.com/i], jsVars: ['CookieConsent', 'Cookiebot'] } },
  { name: 'Iubenda (CMP)', category: 'Consent Management', patterns: { urls: [/cdn\.iubenda\.com/i], html: [/iubenda\.com/i], jsVars: ['_iub', '_iubCookieSolutionConfig'] } },
  { name: 'OneTrust (CMP)', category: 'Consent Management', patterns: { urls: [/cdn\.cookielaw\.org/i], html: [/cookielaw\.org/i], jsVars: ['OneTrust', 'OptanonWrapper'] } },
  { name: 'Axeptio (CMP)', category: 'Consent Management', patterns: { urls: [/static\.axept\.io/i], html: [/axept\.io/i, /axeptioSettings/i], jsVars: ['axeptioSettings', '_axcb'] } },
  { name: 'Didomi (CMP)', category: 'Consent Management', patterns: { urls: [/sdk\.privacy-center\.org/i], html: [/privacy-center\.org/i, /didomiOnReady/i], jsVars: ['Didomi', 'didomiOnReady'] } },
  // Programmatic
  { name: 'Xandr (AppNexus)', category: 'Programmatic', patterns: { urls: [/secure\.adnxs\.com/i, /ib\.adnxs\.com/i], html: [/adnxs\.com/i], jsVars: ['apntag'] } },
  { name: 'Pubmatic', category: 'Programmatic', patterns: { urls: [/ads\.pubmatic\.com/i], html: [], jsVars: ['PubMaticSDK'] } },
  { name: 'Magnite (Rubicon)', category: 'Programmatic', patterns: { urls: [/eus\.rubiconproject\.com/i], html: [/rubiconproject\.com/i], jsVars: ['rubicontag'] } },
  { name: 'Index Exchange', category: 'Programmatic', patterns: { urls: [/casalemedia\.com/i], html: [/casalemedia\.com/i], jsVars: [] } },
  // Identity / Audience
  { name: 'LiveRamp (ATS)', category: 'Identity Resolution', patterns: { urls: [/ats\.rlcdn\.com/i, /api\.rlcdn\.com/i], html: [/rlcdn\.com/i], jsVars: ['__atsLoaded'] } },
  { name: 'Nielsen', category: 'Audience Measurement', patterns: { urls: [/secure-us\.imrworldwide\.com/i], html: [/imrworldwide\.com/i], jsVars: ['NOLCMB'] } },
  { name: 'comScore', category: 'Audience Measurement', patterns: { urls: [/sb\.scorecardresearch\.com/i], html: [/scorecardresearch\.com/i], jsVars: ['COMSCORE', '_comscore'] } },
];

// ── Detection helpers ─────────────────────────────────────────────────────────

function extractScriptContext(html) {
  const scriptTags   = html.match(/<script[\s\S]*?<\/script>/gi) || [];
  const noscriptTags = html.match(/<noscript[\s\S]*?<\/noscript>/gi) || [];
  const srcAttrs     = html.match(/(?:src|href)=["'][^"']{4,}["']/gi) || [];
  return [...scriptTags, ...noscriptTags, ...srcAttrs].join('\n');
}

function detectInHtml(html, sigs) {
  const ctx = extractScriptContext(html);
  return sigs.flatMap(tag => {
    const matched = (tag.patterns.html || []).filter(re => re.test(ctx));
    return matched.length ? [{ tag, evidence: matched.map(p => `HTML: ${p.source}`), source: 'html' }] : [];
  });
}

function detectInRequests(requests, sigs) {
  const results = new Map();
  for (const url of requests) {
    let urlToMatch;
    try { const p = new URL(url); urlToMatch = p.hostname + p.pathname; } catch { urlToMatch = url; }
    for (const tag of sigs) {
      const matched = (tag.patterns.urls || []).filter(re => re.test(urlToMatch));
      if (!matched.length) continue;
      if (!results.has(tag.name)) results.set(tag.name, { tag, evidence: [], source: 'network' });
      results.get(tag.name).evidence.push(`NET: ${url}`);
    }
  }
  return Array.from(results.values());
}

async function detectJsVars(page, sigs) {
  const found = [];
  for (const tag of sigs) {
    const vars = tag.patterns.jsVars;
    if (!vars || !vars.length) continue;
    const present = await page.evaluate(v =>
      v.filter(name => { try { return typeof window[name] !== 'undefined'; } catch { return false; } }), vars
    );
    if (present.length) found.push({ tag, evidence: present.map(n => `JS: window.${n}`), source: 'js' });
  }
  return found;
}

async function detectJsChecks(page, sigs) {
  const found = [];
  for (const tag of sigs) {
    const checks = tag.patterns.jsChecks;
    if (!checks || !checks.length) continue;
    for (const check of checks) {
      const hit = await page.evaluate(expr => { try { return Boolean(eval(expr)); } catch { return false; } }, check.expr); // eslint-disable-line no-eval
      if (hit) { found.push({ tag, evidence: [`JS: ${check.label}`], source: 'js' }); break; }
    }
  }
  return found;
}

function mergeResults(all) {
  const merged = new Map();
  for (const { tag, evidence, source } of all) {
    if (!merged.has(tag.name)) merged.set(tag.name, { tag, evidence: [], sources: new Set() });
    const entry = merged.get(tag.name);
    entry.sources.add(source);
    for (const ev of evidence) { if (!entry.evidence.includes(ev)) entry.evidence.push(ev); }
  }
  return Array.from(merged.values()).sort(
    (a, b) => a.tag.category.localeCompare(b.tag.category) || a.tag.name.localeCompare(b.tag.name)
  );
}

async function acceptCookieBanner(page) {
  const cmpSelectors = [
    '#onetrust-accept-btn-handler', '.onetrust-accept-btn-handler',
    '#CybotCookiebotDialogBodyButtonAccept', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '.iubenda-cs-accept-btn', '#iubenda-cs-btn-accept',
    '.axeptio_btn_acceptAll', '[data-cy="axeptio_btn_acceptAll"]',
    '#didomi-notice-agree-button',
    '[data-testid="uc-accept-all-button"]',
    '[aria-label*="accept all" i]', '[aria-label*="accetta tutto" i]',
  ];
  for (const sel of cmpSelectors) {
    try { const el = await page.$(sel); if (el) { await el.click(); return sel; } } catch {}
  }
  const acceptTexts = [
    'accetta tutto', 'accetta tutti', 'accept all', 'accept all cookies',
    'allow all', 'allow all cookies', 'tout accepter', 'alle akzeptieren',
    'i accept all', 'i agree', 'ok, accetto', 'ho capito',
  ];
  const clicked = await page.evaluate(texts => {
    const isVisible = el => {
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0 && el.offsetWidth > 0;
    };
    for (const el of [...document.querySelectorAll('button,[role="button"],a,input[type="submit"]')].filter(isVisible)) {
      const raw = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
      if (texts.some(t => raw === t || raw.startsWith(t + ' ') || raw.endsWith(' ' + t))) { el.click(); return raw; }
    }
    return null;
  }, acceptTexts);
  return clicked || null;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function scanUrl(url) {
  const normalizedUrl = url.startsWith('http') ? url : `https://${url}`;
  const networkUrls = [];
  const startTime = Date.now();

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setRequestInterception(true);
    page.on('request', req => { networkUrls.push(req.url()); req.continue(); });
    page.on('response', res => { const u = res.url(); if (!networkUrls.includes(u)) networkUrls.push(u); });

    await page.goto(normalizedUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500));

    const bannerResult = await acceptCookieBanner(page);
    if (bannerResult) await new Promise(r => setTimeout(r, 3000));
    await new Promise(r => setTimeout(r, 2000));

    const html = await page.content();
    const results = mergeResults([
      ...detectInHtml(html, TAG_SIGNATURES),
      ...detectInRequests(networkUrls, TAG_SIGNATURES),
      ...await detectJsVars(page, TAG_SIGNATURES),
      ...await detectJsChecks(page, TAG_SIGNATURES),
    ]);

    const elapsed = Date.now() - startTime;
    return {
      url: normalizedUrl,
      elapsed_ms: elapsed,
      network_requests: networkUrls.length,
      cookie_banner_accepted: !!bannerResult,
      tags_found: results.length,
      tags: results.map(({ tag, evidence, sources }) => ({
        name: tag.name,
        category: tag.category,
        sources: [...sources],
        evidence,
      })),
    };
  } finally {
    await browser.close();
  }
}

module.exports = { scanUrl, TAG_SIGNATURES };
