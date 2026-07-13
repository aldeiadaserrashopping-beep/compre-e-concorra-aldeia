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
    valorUnidade: 500.0,
    qtdPremios: 2,
    qtdGanhadores: 2,
    dataInicio: '2026-07-24',
    dataFim: '2026-08-09',
    dataApuracao: '2026-08-19', // extração da Loteria Federal (quarta-feira)
    numCertificadoSPA: null, // BLOQUEIA go-live real até preencher (Seção 22)
    acumulaSaldo: true,
    seriesConfig: { serieAtual: 1, proximoNumero: 0, tamanhoSerie: 100000, digitos: 5 },
    // Lojas participantes (Relação Oficial — Julho/2026). Só dígitos.
    lojasParticipantesCNPJ: [
      '47361452000324', // AD LIFE — Sergios Vitoria Comercio de Calcados Ltda
      '59273034000100', // ASK SPOLETO — Ask Serra Foods Ltda
      '58385800204',    // CACAU SHOW — consta como PESSOA FÍSICA (CPF) => CONFIRMAR CNPJ de emissão
      '57902761000156', // CLÍNICA DERMAVIVA
      '59302709000194', // GIRAFFAS — GFF Serra Foods Ltda
      '39829064000135', // HAVE FUN — Rick Comercio e Locacao Ltda
      '59272743000163', // HMP — HMP Serra Foods Ltda
      '14979684000120', // INBRAND STORE — Coke Luxo Comercio de Roupas Ltda
      '34084985000100', // MAHAI — Restaurante Mahai ES Ltda
      '62098606000169', // NATURA ALDEIA — GM Aldeia Cosméticos Ltda
      '57137821000191', // PITICO KIDS — MC Comércio de Brinquedos Ltda
      '14979684001100', // SIX CLUB — Coke Luxo Comercio de Roupas Ltda (filial)
      '13305908000155', // SMART FIT — Trindade Serviços Operacionais Ltda
      '34230660000261', // VIA MIA — Vitoria Calçados Ltda
      '15743430000251', // OFTALMOPLUS — Centro de Cuidados Oftalmologicos e Especialidades Ltda
      '26217704000104', // ÓTICAS DINIZ — VLE Comercio de Otica Ltda
      '46727672000102', // ÓTICAS MAIA — Oticas M.Maia Ltda
    ],
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
