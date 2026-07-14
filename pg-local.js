'use strict';
/**
 * Sobe um PostgreSQL local descartável para rodar o teste de integração.
 * Só para desenvolvimento — em produção o banco é o Render Postgres.
 * Uso: node pg-local.js iniciar | parar
 */
const path = require('path');
const EmbeddedPostgres = require('/tmp/pgtest/node_modules/embedded-postgres').default;

const DIR = path.join('/tmp', 'pg-aldeia');
const PORTA = 5433;

const pg = new EmbeddedPostgres({
  databaseDir: DIR, user: 'aldeia', password: 'aldeia',
  port: PORTA, persistent: true,
});

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'iniciar') {
    const fs = require('fs');
    if (!fs.existsSync(path.join(DIR, 'PG_VERSION'))) await pg.initialise();
    await pg.start();
    try { await pg.createDatabase('aldeia_teste'); } catch { /* já existe */ }
    console.log(`postgresql://aldeia:aldeia@localhost:${PORTA}/aldeia_teste`);
  } else if (cmd === 'parar') {
    await pg.stop();
    console.log('parado');
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
