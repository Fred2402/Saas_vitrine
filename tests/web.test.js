// Tests navigateur de suivi.html et admin.html.
// Le site est construit dans un dossier temporaire, servi via l'interception réseau de Playwright,
// et toutes les requêtes Supabase reçoivent des réponses simulées.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SITE = 'https://app.test';
const SB = 'https://test.supabase.co';
const ANON = 'cle-anon-de-test';

let out;
let browser;

const MIME = { '.html': 'text/html', '.js': 'application/javascript' };

// En-têtes de vercel.json appliqués aux réponses du site (vérifie que la CSP ne bloque rien)
const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
function siteHeaders(pathname) {
  const headers = {};
  for (const rule of VERCEL.headers) {
    if (new RegExp('^' + rule.source + '$').test(pathname)) {
      rule.headers.forEach((h) => { headers[h.key.toLowerCase()] = h.value; });
    }
  }
  return headers;
}

const TRACKED = {
  tracking_code: 'GC-AB12CD34',
  description: 'Carton vêtements',
  status: 'en_transit',
  origin: 'Chine',
  destination: 'Libreville',
  eta: '2026-11-30',
  container_ref: 'MSKU1234567',
  forwarder: { name: 'Transit Demo', color: '#aa3300', phone: '+241 01 23 45 67' },
  events: [
    { status: 'en_transit', location: 'Océan Indien', note: 'Départ confirmé', at: '2026-10-20T08:00:00Z' },
    { status: 'expedie', location: 'Shenzhen', note: null, at: '2026-10-15T08:00:00Z' },
    { status: 'enregistre', location: null, note: null, at: '2026-10-01T08:00:00Z' }
  ]
};

before(async () => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-site-'));
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build.js')], {
    env: { ...process.env, OUT_DIR: out, SUPABASE_URL: SB, SUPABASE_ANON_KEY: ANON, TRACKING_BASE_URL: SITE + '/suivi-colis/suivi.html' },
    stdio: 'pipe'
  });
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  fs.rmSync(out, { recursive: true, force: true });
});

// Ouvre une page : le site vient du dossier construit, Supabase est simulé par `api`,
// toute autre requête externe est bloquée et signalée.
async function open(pagePath, api, options = {}) {
  const context = await browser.newContext({ timezoneId: options.timezoneId || 'Africa/Libreville', locale: 'fr-FR' });
  const page = await context.newPage();
  const calls = [];
  const blocked = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (/Content Security Policy/.test(m.text())) errors.push(m.text()); });

  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === SITE) {
      const file = path.join(out, decodeURIComponent(url.pathname));
      if (!file.startsWith(out) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'introuvable' });
      return route.fulfill({
        status: 200,
        headers: { ...siteHeaders(url.pathname), 'content-type': MIME[path.extname(file)] },
        body: fs.readFileSync(file)
      });
    }
    if (url.origin === SB) {
      if (req.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: cors() });
      }
      const call = { method: req.method(), path: url.pathname, search: url.search, headers: req.headers(), body: req.postData() };
      calls.push(call);
      return api(route, call);
    }
    // Polices Google : réponse vide pour rester hors ligne
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
      return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    }
    blocked.push(req.url());
    return route.abort();
  });

  await page.goto(SITE + pagePath);
  return { page, context, calls, blocked, errors };
}

function cors() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-expose-headers': 'content-range'
  };
}

function json(route, status, body) {
  return route.fulfill({ status, headers: { ...cors(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

// ------------------------------------------------------------------ suivi.html

test('suivi : affichage du statut et de l\'historique', async () => {
  const { page, context, calls, blocked, errors } = await open('/suivi-colis/suivi.html', (route) => json(route, 200, TRACKED));
  await page.fill('#code', 'gc-ab12cd34');
  await page.click('#btn');
  await page.waitForSelector('#result:not([hidden])');

  assert.equal(await page.textContent('#status'), 'En transit maritime');
  assert.equal(await page.textContent('#title'), 'Transit Demo');
  assert.equal(await page.$eval('#bar', (e) => e.style.width), '50%');
  assert.equal(await page.textContent('#codeOut'), 'GC-AB12CD34');
  assert.equal(await page.textContent('#phase'), 'En mer');
  const steps = await page.$$eval('#events li', (els) => els.map((e) => e.className + ':' + e.querySelector('.ev-t').textContent));
  assert.equal(steps.length, 9);
  assert.deepEqual(steps.slice(3, 6), ['done:Conteneur expédié', 'now:En transit maritime', 'todo:Arrivé au port de destination']);
  const now = await page.textContent('#events li.now');
  assert.match(now, /Océan Indien/);
  assert.match(now, /Départ confirmé/);
  assert.match(await page.textContent('#events li:nth-child(4)'), /Shenzhen/);
  assert.match(await page.textContent('#eta'), /30 novembre 2026/);
  assert.match(await page.textContent('#details'), /MSKU1234567/);
  assert.match(await page.textContent('#contact'), /\+241 01 23 45 67/);
  assert.equal(await page.isHidden('#error'), true);
  assert.match(page.url(), /\?code=gc-ab12cd34$/);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/rest/v1/rpc/track_shipment');
  assert.deepEqual(JSON.parse(calls[0].body), { p_code: 'gc-ab12cd34' });
  assert.equal(calls[0].headers.apikey, ANON);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  await context.close();
});

test('suivi : code passé dans l\'URL et date estimée hors fuseau africain', async () => {
  const { page, context, calls } = await open('/suivi-colis/suivi.html?code=GC-AB12CD34', (route) => json(route, 200, TRACKED), { timezoneId: 'America/New_York' });
  await page.waitForSelector('#result:not([hidden])');
  assert.equal(await page.inputValue('#code'), 'GC-AB12CD34');
  assert.match(await page.textContent('#eta'), /30 novembre 2026/);
  assert.equal(calls.length, 1);
  await context.close();
});

test('suivi : code inconnu', async () => {
  const { page, context } = await open('/suivi-colis/suivi.html', (route) => json(route, 200, null));
  await page.fill('#code', 'GC-INCONNU');
  await page.click('#btn');
  await page.waitForSelector('#error:not([hidden])');
  assert.match(await page.textContent('#error'), /Aucun colis trouvé/);
  assert.equal(await page.isHidden('#result'), true);
  assert.equal(await page.isEnabled('#btn'), true);
  await context.close();
});

test('suivi : erreur réseau puis erreur serveur', async () => {
  let mode = 'abort';
  const { page, context } = await open('/suivi-colis/suivi.html', (route) =>
    mode === 'abort' ? route.abort('failed') : json(route, 500, { message: 'erreur' }));
  await page.fill('#code', 'GC-AB12CD34');
  await page.click('#btn');
  await page.waitForSelector('#error:not([hidden])');
  assert.match(await page.textContent('#error'), /momentanément indisponible/);

  mode = 'http500';
  await page.evaluate(() => { document.getElementById('error').hidden = true; });
  await page.click('#btn');
  await page.waitForSelector('#error:not([hidden])');
  assert.match(await page.textContent('#error'), /momentanément indisponible/);
  assert.equal(await page.isHidden('#result'), true);
  await context.close();
});

// ------------------------------------------------------------------ admin.html

function fakeJwt(sub, email) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return [b64({ alg: 'HS256', typ: 'JWT' }), b64({ sub, email, role: 'authenticated', aud: 'authenticated', exp, iat: exp - 3600 }), 'signature'].join('.');
}

const USER = { id: '11111111-1111-1111-1111-111111111111', email: 'transit@exemple.test', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };

function adminApi(state) {
  return (route, call) => {
    const p = call.path;
    if (p === '/auth/v1/token') {
      const body = JSON.parse(call.body || '{}');
      if (body.password !== 'bon-mot-de-passe') {
        return json(route, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      }
      const token = fakeJwt(USER.id, USER.email);
      return json(route, 200, {
        access_token: token, token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh', user: USER
      });
    }
    if (p === '/auth/v1/logout') return route.fulfill({ status: 204, headers: cors() });
    if (p === '/auth/v1/user') return json(route, 200, USER);
    if (p === '/rest/v1/forwarders') return json(route, 200, [{ id: 'fw1', name: 'Transit Demo', brand_color: '#aa3300' }]);
    if (p === '/rest/v1/shipments' && call.method === 'GET') return json(route, 200, state.shipments);
    if (p === '/rest/v1/shipments' && call.method === 'POST') {
      const row = JSON.parse(call.body);
      state.shipments.unshift({ id: 's' + (state.shipments.length + 1), tracking_code: 'GC-NOUVEAU1', status: 'enregistre', ...row });
      return json(route, 201, { tracking_code: 'GC-NOUVEAU1' });
    }
    if (p === '/rest/v1/shipment_events') return json(route, 200, state.events);
    if (p === '/rest/v1/rpc/set_shipment_status') {
      const b = JSON.parse(call.body);
      const s = state.shipments.find((x) => x.id === b.p_shipment_id);
      s.status = b.p_status;
      return route.fulfill({ status: 204, headers: cors() });
    }
    return json(route, 404, { message: 'route simulée absente : ' + call.method + ' ' + p });
  };
}

function adminState() {
  return {
    shipments: [
      { id: 's1', tracking_code: 'GC-AB12CD34', client_name: 'Client Un', client_phone: '24101234567', description: 'Carton', container_ref: 'MSKU1', status: 'recu_entrepot', eta: '2026-11-30', created_at: '2026-10-01T08:00:00Z' },
      { id: 's2', tracking_code: 'GC-EF56GH78', client_name: 'Client Deux', client_phone: null, description: 'Valise', container_ref: null, status: 'livre', eta: null, created_at: '2026-09-01T08:00:00Z' }
    ],
    events: [{ status: 'recu_entrepot', location: 'Guangzhou', note: null, created_at: '2026-10-02T08:00:00Z' }]
  };
}

async function login(page, password) {
  await page.waitForSelector('#login:not([hidden])');
  await page.fill('#email', USER.email);
  await page.fill('#pwd', password);
  await page.click('#login-form button[type=submit]');
}

test('en-têtes : CSP active et noindex sur admin', () => {
  assert.match(siteHeaders('/suivi-colis/suivi.html')['content-security-policy'], /script-src 'self'/);
  assert.equal(siteHeaders('/suivi-colis/suivi.html')['x-robots-tag'], undefined);
  assert.equal(siteHeaders('/suivi-colis/admin.html')['x-robots-tag'], 'noindex, nofollow');
});

test('admin : identifiants incorrects', async () => {
  const { page, context } = await open('/suivi-colis/admin.html', adminApi(adminState()));
  await login(page, 'mauvais');
  await page.waitForSelector('#login-msg:not([hidden])');
  assert.equal(await page.textContent('#login-msg'), 'Identifiants incorrects.');
  assert.equal(await page.isHidden('#app'), true);
  await context.close();
});

test('admin : connexion, liste, changement de statut, création et déconnexion', async () => {
  const state = adminState();
  const { page, context, calls, blocked, errors } = await open('/suivi-colis/admin.html', adminApi(state));
  await login(page, 'bon-mot-de-passe');
  await page.waitForSelector('#app:not([hidden])');
  await page.waitForSelector('#rows tr');

  assert.equal(await page.textContent('#company'), 'Transit Demo');
  assert.equal(await page.textContent('#who'), USER.email);
  assert.equal(await page.$$eval('#rows > tr', (r) => r.length), 2);
  const fwCall = calls.find((c) => c.path === '/rest/v1/forwarders');
  assert.match(decodeURIComponent(fwCall.search), /select=id,name(&|$)/);
  assert.match(fwCall.headers.authorization, /^Bearer ey/);

  // Filtre et recherche
  await page.selectOption('#filter', 'livre');
  assert.equal(await page.$$eval('#rows > tr', (r) => r.length), 1);
  await page.selectOption('#filter', '');
  await page.fill('#search', 'msku1');
  assert.equal(await page.$$eval('#rows > tr', (r) => r.length), 1);
  await page.fill('#search', '');

  // Changement de statut
  await page.click('#rows tr:first-child button');
  await page.waitForSelector('#rows tr.detail .events li >> text=Guangzhou');
  assert.match(await page.textContent('#rows tr.detail'), /30\/11\/2026/);
  await page.selectOption('#rows tr.detail select', 'groupage');
  await page.fill('#rows tr.detail input[aria-label="Lieu"]', 'Entrepôt Canton');
  await page.fill('#rows tr.detail input[aria-label="Note"]', 'Prêt pour le conteneur');
  await page.click('#rows tr.detail button:has-text("Mettre à jour")');
  await page.waitForSelector('#app-msg.ok:not([hidden])');
  assert.match(await page.textContent('#app-msg'), /Statut mis à jour/);
  const rpc = calls.find((c) => c.path === '/rest/v1/rpc/set_shipment_status');
  assert.deepEqual(JSON.parse(rpc.body), { p_shipment_id: 's1', p_status: 'groupage', p_location: 'Entrepôt Canton', p_note: 'Prêt pour le conteneur' });
  await page.waitForFunction(() => document.querySelector('#rows tr:first-child .pill').textContent === 'Groupage');

  // Compteurs par phase et filtre associé
  const stats = await page.$$eval('#stats .stat', (els) => els.map((e) => e.textContent));
  assert.deepEqual(stats, ['1En préparation', '0En mer', '0Au port', '0À retirer', '1Livrés']);
  await page.click('#stats .stat:has-text("Livrés")');
  assert.equal(await page.$$eval('#rows > tr:not(.detail)', (r) => r.length), 1);
  await page.click('#stats .stat:has-text("Livrés")');

  // Création d'un colis
  await page.click('#toggle-new');
  await page.fill('#n-client', 'Client Trois');
  await page.fill('#n-phone', '+241 01 98 76 54');
  await page.fill('#n-weight', '12.5');
  await page.click('#new-form button[type=submit]');
  await page.waitForFunction(() => /GC-NOUVEAU1/.test(document.getElementById('app-msg').textContent));
  const ins = calls.find((c) => c.path === '/rest/v1/shipments' && c.method === 'POST');
  assert.deepEqual(JSON.parse(ins.body), {
    forwarder_id: 'fw1', client_name: 'Client Trois', client_phone: '24101987654',
    description: null, weight_kg: 12.5, container_ref: null, eta: null
  });
  await page.waitForFunction(() => document.querySelectorAll('#rows > tr:not(.detail)').length === 3);
  assert.equal(await page.inputValue('#n-client'), '');

  // Déconnexion
  await page.click('#logout');
  await page.waitForSelector('#login:not([hidden])');
  assert.equal(await page.isHidden('#app'), true);

  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  await context.close();
});

test('admin : erreur lors du changement de statut', async () => {
  const state = adminState();
  const base = adminApi(state);
  const { page, context } = await open('/suivi-colis/admin.html', (route, call) =>
    call.path === '/rest/v1/rpc/set_shipment_status'
      ? json(route, 400, { code: 'P0001', message: 'colis introuvable' })
      : base(route, call));
  await login(page, 'bon-mot-de-passe');
  await page.waitForSelector('#rows tr');
  await page.click('#rows tr:first-child button');
  await page.selectOption('#rows tr.detail select', 'livre');
  await page.click('#rows tr.detail button:has-text("Mettre à jour")');
  await page.waitForSelector('#app-msg.err:not([hidden])');
  assert.match(await page.textContent('#app-msg'), /colis introuvable/);
  assert.equal(state.shipments[0].status, 'recu_entrepot');
  await context.close();
});
