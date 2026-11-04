// Validation statique des workflows n8n : JSON, connexions, syntaxe des nœuds Code
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'chatbot-whatsapp/workflow-chatbot.json',
  'suivi-colis/workflow-notification.json'
];

for (const file of FILES) {
  test(file, async (t) => {
    const raw = fs.readFileSync(path.join(ROOT, file), 'utf8');
    let wf;

    await t.test('JSON valide', () => {
      wf = JSON.parse(raw);
      assert.ok(Array.isArray(wf.nodes) && wf.nodes.length > 0, 'nodes vide');
      assert.equal(typeof wf.connections, 'object');
    });

    await t.test('noms de nœuds uniques', () => {
      const names = wf.nodes.map((n) => n.name);
      assert.equal(new Set(names).size, names.length);
    });

    await t.test('connexions vers des nœuds existants', () => {
      const names = new Set(wf.nodes.map((n) => n.name));
      for (const [src, outputs] of Object.entries(wf.connections)) {
        assert.ok(names.has(src), `source inconnue : ${src}`);
        for (const branch of Object.values(outputs)) {
          for (const targets of branch) {
            for (const c of targets || []) {
              assert.ok(names.has(c.node), `${src} -> cible inconnue : ${c.node}`);
            }
          }
        }
      }
    });

    await t.test('jsCode passe node --check', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
      try {
        wf.nodes.filter((n) => n.parameters && n.parameters.jsCode).forEach((n, i) => {
          // n8n exécute le code dans une fonction asynchrone : on reproduit l'enveloppe
          const f = path.join(dir, `node${i}.js`);
          fs.writeFileSync(f, `(async function () {\n${n.parameters.jsCode}\n});\n`);
          try {
            execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
          } catch (e) {
            assert.fail(`${n.name} : ${e.stderr.toString()}`);
          }
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
