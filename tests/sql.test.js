// Exécute les scripts SQL sur une base Postgres jetable.
// Connexion via les variables standard PGHOST, PGPORT, PGUSER, PGPASSWORD.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DB = 'kit_saas_test_' + process.pid;

function psql(args, db = 'postgres') {
  return execFileSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-d', db, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function run(file) {
  try {
    return psql(['-f', path.join(ROOT, file)], DB);
  } catch (e) {
    assert.fail(`${file}\n${e.stderr || e.message}`);
  }
}

test('SQL', async (t) => {
  psql(['-c', `drop database if exists ${DB}`]);
  psql(['-c', `create database ${DB}`]);
  try {
    await t.test('bootstrap Supabase minimal', () => { run('tests/sql/bootstrap.sql'); });
    await t.test('schema.sql', () => { run('schema.sql'); });
    await t.test('schema.sql rejouable', () => { run('schema.sql'); });
    await t.test('seed-exemple.sql', () => { run('seed-exemple.sql'); });
    await t.test('migration-backoffice.sql', () => { run('suivi-colis/migration-backoffice.sql'); });
    await t.test('vérifications fonctionnelles', (st) => {
      const out = run('tests/sql/checks.sql');
      const oks = out.split('\n').filter((l) => l.startsWith('ok - '));
      oks.forEach((l) => st.diagnostic(l));
      assert.equal(oks.length, 5);
    });
  } finally {
    psql(['-c', `drop database if exists ${DB}`]);
  }
});
