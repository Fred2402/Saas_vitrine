// Configuration publique générée au déploiement (config.js) : URL Supabase et clé "anon"
const CONFIG = window.APP_CONFIG || {};
const SUPABASE_URL = CONFIG.SUPABASE_URL;
const SUPABASE_ANON_KEY = CONFIG.SUPABASE_ANON_KEY;

const STEPS = ['enregistre', 'recu_entrepot', 'groupage', 'expedie', 'en_transit', 'arrive_port', 'dedouanement', 'disponible', 'livre'];
const LABELS = {
  enregistre: 'Colis enregistré',
  recu_entrepot: "Reçu à l'entrepôt en Chine",
  groupage: 'Intégré au groupage',
  expedie: 'Conteneur expédié',
  en_transit: 'En transit maritime',
  arrive_port: 'Arrivé au port de destination',
  dedouanement: 'En cours de dédouanement',
  disponible: 'Disponible au retrait',
  livre: 'Livré'
};
const PHASE = { enregistre: 'En préparation', recu_entrepot: 'En préparation', groupage: 'En préparation', expedie: 'En mer', en_transit: 'En mer',
                arrive_port: 'Au port', dedouanement: 'Au port', disponible: 'À retirer', livre: 'Livré' };

const $ = (id) => document.getElementById(id);
const form = $('form'), codeInput = $('code'), btn = $('btn');
const fmt = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

function showError(msg) {
  $('result').hidden = true;
  $('error').textContent = msg;
  $('error').hidden = false;
}

function row(dl, label, value) {
  if (!value) return;
  const dt = document.createElement('dt'); dt.textContent = label;
  const dd = document.createElement('dd'); dd.textContent = value;
  dl.append(dt, dd);
}

function renderEta(d) {
  const box = $('eta');
  box.className = 'eta';
  box.replaceChildren();
  const big = document.createElement('strong');
  const small = document.createElement('span');
  if (d.status === 'livre') { big.textContent = 'Livré'; small.textContent = 'Votre colis a été remis.'; }
  else if (d.status === 'disponible') { big.textContent = 'À retirer'; small.textContent = 'Présentez votre code de suivi pour récupérer le colis.'; }
  else if (d.eta) {
    const days = Math.ceil((new Date(d.eta + 'T12:00:00') - new Date()) / 86400000);
    if (days > 1) { big.textContent = 'J-' + days; small.textContent = 'Arrivée estimée le ' + fmt(d.eta + 'T12:00:00'); }
    else if (days >= 0) { big.textContent = "Bientôt"; small.textContent = 'Arrivée estimée le ' + fmt(d.eta + 'T12:00:00'); }
    else { big.textContent = Math.abs(days) + ' j de retard'; small.textContent = 'Arrivée prévue le ' + fmt(d.eta + 'T12:00:00') + '. Le transitaire vous tient informé.'; box.classList.add('late'); }
  } else { big.textContent = 'Date à confirmer'; small.textContent = "L'arrivée sera communiquée dès que possible."; }
  box.append(big, small);
}

function render(d) {
  $('error').hidden = true;
  $('title').textContent = d.forwarder?.name || 'Suivi de colis';
  document.title = 'Suivi ' + d.tracking_code;
  $('codeOut').textContent = d.tracking_code;
  $('status').textContent = LABELS[d.status] || d.status;

  const phase = $('phase');
  phase.textContent = PHASE[d.status] || '';
  phase.className = 'phase' + (d.status === 'livre' || d.status === 'disponible' ? ' ok' : '');

  $('orig').textContent = d.origin || 'Chine';
  $('dest').textContent = d.destination || 'Gabon';

  const idx = Math.max(0, STEPS.indexOf(d.status));
  const pct = (idx / (STEPS.length - 1)) * 100;
  $('bar').style.width = pct + '%';
  $('ship').style.left = pct + '%';
  const track = $('track');
  track.querySelectorAll('.dot').forEach((n) => n.remove());
  STEPS.forEach((s, i) => {
    if (i === idx) return;
    const dot = document.createElement('span');
    dot.className = 'dot' + (i < idx ? ' on' : '');
    dot.style.left = (i / (STEPS.length - 1)) * 100 + '%';
    track.append(dot);
  });

  renderEta(d);

  const dl = $('details');
  dl.replaceChildren();
  row(dl, 'Contenu', d.description);
  row(dl, 'Conteneur', d.container_ref);

  // Dernier evenement connu pour chaque etape
  const byStatus = {};
  (d.events || []).forEach((e) => { if (!byStatus[e.status] || new Date(e.at) > new Date(byStatus[e.status].at)) byStatus[e.status] = e; });

  const ol = $('events');
  ol.replaceChildren();
  STEPS.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = i < idx ? 'done' : i === idx ? 'now' : 'todo';
    const pt = document.createElement('span'); pt.className = 'pt';
    const t = document.createElement('div'); t.className = 'ev-t'; t.textContent = LABELS[s];
    li.append(pt, t);
    const e = byStatus[s];
    if (e) {
      const m = document.createElement('div'); m.className = 'ev-m';
      m.textContent = [fmt(e.at), e.location].filter(Boolean).join(' - ');
      li.append(m);
      if (e.note) { const n = document.createElement('div'); n.className = 'ev-m'; n.textContent = e.note; li.append(n); }
    }
    ol.append(li);
  });

  const contact = $('contact');
  if (d.forwarder?.phone) {
    contact.textContent = 'Une question ? Contactez ' + (d.forwarder.name || 'votre transitaire') + ' au ' + d.forwarder.phone + '.';
    contact.hidden = false;
  } else { contact.hidden = true; }
  $('result').hidden = false;
}

async function track(code) {
  btn.disabled = true;
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/track_shipment', {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_code: code })
    });
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    if (!data) return showError('Aucun colis trouvé pour ce code. Vérifiez la saisie.');
    render(data);
  } catch (err) {
    showError('Service momentanément indisponible. Réessayez dans quelques instants.');
  } finally { btn.disabled = false; }
}

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const code = codeInput.value.trim();
  if (!code) return;
  try { history.replaceState(null, '', '?code=' + encodeURIComponent(code)); } catch (e) {}
  track(code);
});

const initial = new URLSearchParams(location.search).get('code');
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  btn.disabled = true;
  showError('Service non configuré. Contactez votre transitaire.');
} else if (initial) { codeInput.value = initial; track(initial); }
