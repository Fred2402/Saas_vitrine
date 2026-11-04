// Construit le site statique dans dist/ (ou OUT_DIR) :
// pages de suivi, bibliothèque Supabase et config.js généré depuis les variables d'environnement.
// config.js ne contient que des valeurs publiques (URL du projet et clé "anon").
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(ROOT, process.env.OUT_DIR || 'dist');
const PAGES = ['suivi.html', 'suivi.js', 'admin.html', 'admin.js'];

function fail(msg) {
  console.error('Erreur de configuration : ' + msg);
  process.exit(1);
}

// Refuse toute clé à privilèges (service_role ou clé secrète) : elle serait publique dans config.js
function isPrivilegedKey(key) {
  if (key.startsWith('sb_secret_')) return true;
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.role === 'service_role';
  } catch (e) {
    return false;
  }
}

const config = {
  SUPABASE_URL: (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, ''),
  SUPABASE_ANON_KEY: (process.env.SUPABASE_ANON_KEY || '').trim(),
  TRACKING_BASE_URL: (process.env.TRACKING_BASE_URL || '').trim()
};

if (!/^https:\/\/[^\s/]+$/.test(config.SUPABASE_URL)) fail('SUPABASE_URL absente ou invalide (https://<projet>.supabase.co).');
if (!config.SUPABASE_ANON_KEY) fail('SUPABASE_ANON_KEY absente.');
if (isPrivilegedKey(config.SUPABASE_ANON_KEY)) fail('SUPABASE_ANON_KEY est une clé à privilèges. Utiliser la clé publique "anon".');
if (config.TRACKING_BASE_URL && !/^https?:\/\/\S+$/.test(config.TRACKING_BASE_URL)) fail('TRACKING_BASE_URL invalide.');

// OUT est vidé avant construction : il ne doit jamais contenir le dépôt
if (OUT === path.parse(OUT).root || !path.relative(OUT, ROOT).startsWith('..')) fail('OUT_DIR ne doit pas contenir le dépôt.');

const site = path.join(OUT, 'suivi-colis');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(site, 'vendor'), { recursive: true });

for (const f of PAGES) fs.copyFileSync(path.join(ROOT, 'suivi-colis', f), path.join(site, f));
fs.copyFileSync(
  require.resolve('@supabase/supabase-js/dist/umd/supabase.js'),
  path.join(site, 'vendor', 'supabase.js')
);
fs.writeFileSync(
  path.join(site, 'config.js'),
  'window.APP_CONFIG = ' + JSON.stringify(config, null, 2) + ';\n'
);

console.log('Site construit dans ' + path.relative(ROOT, OUT) + '/');
