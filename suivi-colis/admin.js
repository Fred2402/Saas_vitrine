// Configuration publique générée au déploiement (config.js) : URL Supabase et clé "anon"
const CONFIG = window.APP_CONFIG || {};
const SUPABASE_URL = CONFIG.SUPABASE_URL;
const SUPABASE_ANON_KEY = CONFIG.SUPABASE_ANON_KEY;
const TRACKING_URL = CONFIG.TRACKING_BASE_URL || new URL('suivi.html', location.href).href;

const STEPS = ['enregistre', 'recu_entrepot', 'groupage', 'expedie', 'en_transit', 'arrive_port', 'dedouanement', 'disponible', 'livre'];
const LABELS = {
  enregistre: 'Enregistré', recu_entrepot: "Reçu à l'entrepôt", groupage: 'Groupage', expedie: 'Expédié', en_transit: 'En transit',
  arrive_port: 'Arrivé au port', dedouanement: 'Dédouanement', disponible: 'Disponible au retrait', livre: 'Livré'
};
const PHASES = [
  { key: 'prep', label: 'En préparation', steps: ['enregistre', 'recu_entrepot', 'groupage'] },
  { key: 'mer', label: 'En mer', steps: ['expedie', 'en_transit'] },
  { key: 'port', label: 'Au port', steps: ['arrive_port', 'dedouanement'] },
  { key: 'retrait', label: 'À retirer', steps: ['disponible'] },
  { key: 'livre', label: 'Livrés', steps: ['livre'] }
];
const phaseOf = (status) => PHASES.find((p) => p.steps.includes(status));

const $ = (id) => document.getElementById(id);
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !window.supabase) {
  const m = $('login-msg');
  m.textContent = 'Service non configuré. Contactez l\'administrateur.';
  m.hidden = false;
  $('login').hidden = false;
  throw new Error('configuration manquante');
}
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let forwarder = null, shipments = [], openId = null, phaseFilter = '';

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  });
  kids.flat().forEach((k) => { if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k))); });
  return el;
}

// Une date "AAAA-MM-JJ" est lue comme minuit UTC par new Date() : on la lit en date locale
function localDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function flash(text, kind) {
  const box = $('app-msg');
  box.textContent = text;
  box.className = 'msg ' + (kind || 'ok');
  box.hidden = false;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { box.hidden = true; }, 6000);
}

async function boot() {
  const { data } = await db.auth.getSession();
  if (!data.session) { $('app').hidden = true; $('login').hidden = false; return; }
  $('login').hidden = true;
  const { data: fw, error } = await db.from('forwarders').select('id,name').limit(1);
  $('app').hidden = false;
  $('who').textContent = data.session.user.email;
  if (error || !fw || !fw.length) {
    flash("Ce compte n'est rattaché à aucune entreprise. Contactez l'administrateur.", 'err');
    $('rows').replaceChildren();
    return;
  }
  forwarder = fw[0];
  $('company').textContent = forwarder.name;
  $('filter').replaceChildren(h('option', { value: '' }, 'Tous les statuts'), ...STEPS.map((s) => h('option', { value: s }, LABELS[s])));
  await load();
}

async function load() {
  const { data, error } = await db.from('shipments').select('*').order('created_at', { ascending: false }).limit(500);
  if (error) return flash('Chargement impossible : ' + error.message, 'err');
  shipments = data || [];
  draw();
}

function drawStats() {
  const box = $('stats');
  box.replaceChildren();
  PHASES.forEach((p) => {
    const n = shipments.filter((s) => p.steps.includes(s.status)).length;
    const b = h('button', { type: 'button', class: 'stat', 'aria-pressed': String(phaseFilter === p.key),
      onclick: () => { phaseFilter = phaseFilter === p.key ? '' : p.key; $('filter').value = ''; draw(); } },
      h('span', { class: 'n' }, n), h('span', { class: 't' }, p.label));
    box.append(b);
  });
}

function draw() {
  drawStats();
  const q = $('search').value.trim().toLowerCase();
  const st = $('filter').value;
  const list = shipments.filter((s) =>
    (!st || s.status === st) &&
    (!phaseFilter || phaseOf(s.status)?.key === phaseFilter) &&
    (!q || [s.client_name, s.tracking_code, s.container_ref, s.description].some((v) => (v || '').toLowerCase().includes(q)))
  );
  const body = $('rows');
  body.replaceChildren();
  $('empty').hidden = list.length > 0;

  list.forEach((s) => {
    const ph = phaseOf(s.status);
    const pct = Math.round((STEPS.indexOf(s.status) / (STEPS.length - 1)) * 100);
    body.append(h('tr', {},
      h('td', { class: 'mono' }, s.tracking_code),
      h('td', {}, s.client_name, h('div', { class: 'mut' }, s.client_phone || '')),
      h('td', { class: 'hide-m' }, s.description || ''),
      h('td', {}, h('span', { class: 'pill' + (ph?.key === 'retrait' || ph?.key === 'livre' ? ' ok' : '') }, LABELS[s.status] || s.status),
        h('div', { class: 'mini' }, h('span', { style: 'width:' + pct + '%' }))),
      h('td', {}, h('button', { class: 'sec sm', type: 'button', onclick: () => { openId = openId === s.id ? null : s.id; draw(); } }, openId === s.id ? 'Fermer' : 'Gérer'))
    ));
    if (openId === s.id) body.append(detailRow(s));
  });
}

function detailRow(s) {
  const sel = h('select', { 'aria-label': 'Nouveau statut' }, ...STEPS.map((x) => h('option', { value: x }, LABELS[x])));
  sel.value = s.status;
  const loc = h('input', { placeholder: 'Ex. Port de Shenzhen', 'aria-label': 'Lieu' });
  const note = h('input', { placeholder: 'Message visible par le client', 'aria-label': 'Note' });
  const save = h('button', { type: 'button', class: 'sm' }, 'Mettre à jour');
  const copy = h('button', { type: 'button', class: 'sec sm' }, 'Copier le lien de suivi');
  const events = h('ul', { class: 'events' }, h('li', {}, 'Chargement...'));

  save.addEventListener('click', async () => {
    save.disabled = true;
    const { error } = await db.rpc('set_shipment_status', {
      p_shipment_id: s.id, p_status: sel.value, p_location: loc.value.trim() || null, p_note: note.value.trim() || null
    });
    save.disabled = false;
    if (error) return flash('Mise à jour impossible : ' + error.message, 'err');
    flash('Statut mis à jour. Le client est notifié sur WhatsApp.');
    await load();
  });

  copy.addEventListener('click', async () => {
    const url = TRACKING_URL + '?code=' + encodeURIComponent(s.tracking_code);
    try { await navigator.clipboard.writeText(url); flash('Lien copié.'); } catch (e) { flash(url); }
  });

  db.from('shipment_events').select('status,location,note,created_at').eq('shipment_id', s.id)
    .order('created_at', { ascending: false }).limit(20).then(({ data, error }) => {
      if (error) return events.replaceChildren(h('li', {}, 'Historique indisponible.'));
      events.replaceChildren(...(data || []).map((e) => h('li', {},
        new Date(e.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) + ' - ' + (LABELS[e.status] || e.status) +
        (e.location ? ' - ' + e.location : '') + (e.note ? ' - ' + e.note : ''))));
    });

  return h('tr', { class: 'detail' },
    h('td', { colspan: '5' },
      h('div', { class: 'grid' },
        h('div', {}, h('label', {}, 'Nouveau statut'), sel),
        h('div', {}, h('label', {}, 'Lieu'), loc),
        h('div', {}, h('label', {}, 'Note pour le client'), note)),
      h('div', { class: 'actions' }, save, copy),
      s.eta ? h('div', { class: 'mut', style: 'margin-top:10px' }, 'Arrivée estimée : ' + localDate(s.eta).toLocaleDateString('fr-FR')) : null,
      events));
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { error } = await db.auth.signInWithPassword({ email: $('email').value.trim(), password: $('pwd').value });
  const m = $('login-msg');
  if (error) { m.textContent = 'Identifiants incorrects.'; m.hidden = false; return; }
  m.hidden = true;
  $('pwd').value = '';
  boot();
});
$('logout').addEventListener('click', async () => { await db.auth.signOut(); forwarder = null; boot(); });

$('toggle-new').addEventListener('click', () => {
  const f = $('new-form');
  f.hidden = !f.hidden;
  $('toggle-new').setAttribute('aria-expanded', String(!f.hidden));
  $('toggle-new').textContent = f.hidden ? 'Ouvrir le formulaire' : 'Fermer le formulaire';
  if (!f.hidden) $('n-client').focus();
});

$('new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!forwarder) return flash('Aucune entreprise rattachée à ce compte.', 'err');
  const row = {
    forwarder_id: forwarder.id,
    client_name: $('n-client').value.trim(),
    client_phone: $('n-phone').value.replace(/\D/g, '') || null,
    description: $('n-desc').value.trim() || null,
    weight_kg: $('n-weight').value ? Number($('n-weight').value) : null,
    container_ref: $('n-cont').value.trim() || null,
    eta: $('n-eta').value || null
  };
  const { data, error } = await db.from('shipments').insert(row).select('tracking_code').single();
  if (error) return flash('Enregistrement impossible : ' + error.message, 'err');
  flash('Colis enregistré. Code de suivi : ' + data.tracking_code);
  e.target.reset();
  load();
});

$('search').addEventListener('input', draw);
$('filter').addEventListener('change', () => { phaseFilter = ''; draw(); });
$('refresh').addEventListener('click', load);

boot();
