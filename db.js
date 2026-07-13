'use strict';
/**
 * Camada de persistência (protótipo) — arquivo JSON com trilha de auditoria append-only.
 * Em produção: PostgreSQL com índices UNIQUE e triggers (ver Especificação, Seção 10).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, 'data', 'db.json');

const VAZIO = () => ({
  campanha: {
    id: 'CAMP-ALDEIA-2026',
    nome: 'Compre e Concorra — 2 Bicicletas Elétricas',
    valorUnidade: 400.0,
    qtdPremios: 2,
    qtdGanhadores: 2,
    dataInicio: '2026-07-01',
    dataFim: '2026-12-24',
    dataApuracao: '2026-12-27',
    numCertificadoSPA: null, // BLOQUEIA go-live real até preencher (Seção 22)
    acumulaSaldo: true,
    seriesConfig: { serieAtual: 1, proximoNumero: 0, tamanhoSerie: 100000, digitos: 5 },
    lojasParticipantesCNPJ: ['12345678000199', '98765432000155'], // exemplo
    denylistCPF: [],
    status: 'ATIVA',
  },
  participantes: [],
  notas: [],
  numeros: [],
  numerosHistorico: [],
  usuarios: [
    // Senha/e-mail podem ser definidos por variável de ambiente ao publicar online
    // (ADMIN_EMAIL / ADMIN_SENHA). Sem elas, usa o padrão de demonstração.
    // Em produção: trocar por argon2/bcrypt + MFA.
    { id: 'U1', nome: 'Administrador',
      email: process.env.ADMIN_EMAIL || 'admin@aldeia.com.br',
      senhaHash: hashSenha(process.env.ADMIN_SENHA || 'admin123'), perfil: 'ADMIN', ativo: true },
  ],
  sorteios: [],
  ganhadores: [],
  auditoria: [], // append-only
  _seq: 0,
});

function hashSenha(s) {
  return crypto.createHash('sha256').update('salt$' + s).digest('hex');
}

let cache = null;

function load() {
  if (cache) return cache;
  try {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    cache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    cache = VAZIO();
    save();
  }
  return cache;
}

function save() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(cache, null, 2));
}

function nextId(prefix) {
  const db = load();
  db._seq += 1;
  return `${prefix}-${db._seq}`;
}

// Trilha de auditoria com hash encadeado (Seção 15)
function auditar({ entidade, entidadeId, acao, usuario, ip, valorAnterior, valorNovo }) {
  const db = load();
  const anterior = db.auditoria.length ? db.auditoria[db.auditoria.length - 1].hash : 'GENESIS';
  const registro = {
    id: nextId('AUD'),
    entidade, entidadeId, acao,
    usuario: usuario || 'sistema',
    ip: ip || null,
    valorAnterior: valorAnterior ?? null,
    valorNovo: valorNovo ?? null,
    dataHora: new Date().toISOString(),
    hashAnterior: anterior,
  };
  registro.hash = crypto.createHash('sha256')
    .update(JSON.stringify({ ...registro })).digest('hex');
  db.auditoria.push(registro);
  save();
  return registro;
}

// Verificação de integridade da cadeia de auditoria
function verificarAuditoria() {
  const db = load();
  let anterior = 'GENESIS';
  for (const r of db.auditoria) {
    if (r.hashAnterior !== anterior) return { ok: false, quebrouEm: r.id };
    const copia = { ...r }; const h = copia.hash; delete copia.hash;
    const recalc = crypto.createHash('sha256').update(JSON.stringify(copia)).digest('hex');
    if (recalc !== h) return { ok: false, quebrouEm: r.id };
    anterior = r.hash;
  }
  return { ok: true, total: db.auditoria.length };
}

module.exports = { load, save, nextId, auditar, verificarAuditoria, hashSenha, VAZIO, DB_FILE };
