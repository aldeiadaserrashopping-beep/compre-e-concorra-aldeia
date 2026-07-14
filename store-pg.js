'use strict';
/**
 * Aldeia Premia — camada de dados (PostgreSQL). ÚNICA camada de persistência.
 *
 * Não existe alternativa em arquivo: um segundo caminho de código para emitir
 * Números da Sorte significaria duas lógicas diferentes para o auditor conferir,
 * e o risco de cair silenciosamente num armazenamento volátil. Sem DATABASE_URL
 * o sistema não sobe (falha alto, não em silêncio).
 *
 * Conformidade (Especificação, Seções 6, 10 e 15):
 *  - Unicidade do Número: UNIQUE (campanha_id, serie, numero) + lock de transação.
 *  - Hash encadeado calculado DENTRO da transação, ordenado por seq (monotônico).
 *  - Auditoria append-only (trigger no banco impede UPDATE/DELETE).
 *  - CPF cifrado em repouso (AES-256-GCM) + hash determinístico para busca.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool, types } = require('pg');
const core = require('./core');

// --- Parsers de tipo: evitam duas classes de bug silencioso -------------------
// DATE (1082): sem isto o driver devolve um objeto Date à meia-noite LOCAL, e
// '2026-07-24' pode voltar como 23/07 dependendo do fuso. Mantemos texto puro.
types.setTypeParser(1082, v => v);
// BIGINT (20): o driver devolve string por segurança. Nossos centavos cabem
// folgadamente em Number (< 2^53), e o resto do código faz aritmética com eles.
types.setTypeParser(20, v => (v === null ? null : parseInt(v, 10)));
// NUMERIC (1700): idem — valor_unidade é dinheiro pequeno.
types.setTypeParser(1700, v => (v === null ? null : Number(v)));

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL não definida. O sistema não sobe sem banco — os cadastros dos ' +
    'participantes não podem depender de disco efêmero.');
}

const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: local ? false : { rejectUnauthorized: false },
  max: 10,
});

const novoId = (p) => `${p}-${crypto.randomBytes(8).toString('hex')}`;

// ---------- criptografia do CPF em repouso (LGPD, art. 46) ----------
function chave() {
  const k = process.env.APP_KEY || '';
  if (!k) throw new Error('APP_KEY não definida — necessária para cifrar CPF em repouso.');
  const buf = /^[0-9a-f]{64}$/i.test(k) ? Buffer.from(k, 'hex') : Buffer.from(k, 'base64');
  if (buf.length !== 32) {
    throw new Error(
      `APP_KEY tem ${buf.length} bytes; o AES-256 exige exatamente 32. ` +
      'Atenção: geradores de secret costumam produzir 16 bytes (32 caracteres hex). ' +
      'Gere assim: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return buf;
}
function cifra(txt) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave(), iv);
  const enc = Buffer.concat([c.update(String(txt), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
function decifra(pacote) {
  const [iv, tag, enc] = String(pacote).split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', chave(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

// ---------- senha: scrypt (nativo do Node) ----------
function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(senha), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${dk.toString('base64')}`;
}
function conferirSenha(senha, guardado) {
  const [alg, salt, dk] = String(guardado || '').split('$');
  if (alg !== 'scrypt') return false;
  const calc = crypto.scryptSync(String(senha), Buffer.from(salt, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const esperado = Buffer.from(dk, 'base64');
  return calc.length === esperado.length && crypto.timingSafeEqual(calc, esperado);
}

const SENTINELA = 'aldeia-premia-sentinela-v1';

/**
 * Confere que a APP_KEY atual é a MESMA que cifrou os dados já gravados.
 *
 * Trocar a APP_KEY não dá erro na hora: o sistema sobe, aceita cadastros novos
 * e só falha quando alguém tenta ler um CPF antigo — possivelmente na hora de
 * gerar a lista do SCPC, com a campanha encerrada e sem como voltar atrás.
 * A sentinela transforma isso num erro de boot, alto e imediato.
 */
async function conferirSentinela() {
  const { rows } = await pool.query("SELECT valor FROM sentinela_chave WHERE id = 'app_key'");
  if (!rows.length) {
    await pool.query("INSERT INTO sentinela_chave (id, valor) VALUES ('app_key', $1)", [cifra(SENTINELA)]);
    return;
  }
  try {
    if (decifra(rows[0].valor) !== SENTINELA) throw new Error('conteúdo inesperado');
  } catch {
    throw new Error(
      'A APP_KEY atual NÃO é a que cifrou os dados deste banco. Os CPFs já ' +
      'gravados não podem ser lidos com esta chave. Restaure a APP_KEY original ' +
      'antes de subir — não apague a sentinela para "resolver".');
  }
}

// ---------- infraestrutura ----------
const q = (texto, params) => pool.query(texto, params);
const ex = (cli) => cli || pool;

async function tx(fn) {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const r = await fn(cli);
    await cli.query('COMMIT');
    return r;
  } catch (e) {
    await cli.query('ROLLBACK');
    throw e;
  } finally {
    cli.release();
  }
}

async function init(campanhaPadrao) {
  // Valida a APP_KEY AQUI, no boot, e não no primeiro uso: uma chave errada
  // precisa derrubar o deploy (o Render mantém a versão anterior no ar), e não
  // esperar o primeiro participante se cadastrar para dar erro na cara dele.
  chave();

  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  await conferirSentinela();

  const { rows } = await pool.query('SELECT id FROM campanha WHERE id = $1', [campanhaPadrao.id]);
  if (!rows.length) {
    const c = campanhaPadrao;
    await pool.query(
      `INSERT INTO campanha (id,nome,valor_unidade,qtd_premios,qtd_ganhadores,data_inicio,data_fim,
         data_apuracao,num_certificado_spa,acumula_saldo,serie_atual,proximo_numero,tamanho_serie,digitos,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [c.id, c.nome, c.valorUnidade, c.qtdPremios, c.qtdGanhadores, c.dataInicio, c.dataFim,
       c.dataApuracao, c.numCertificadoSPA, c.acumulaSaldo, c.seriesConfig.serieAtual,
       c.seriesConfig.proximoNumero, c.seriesConfig.tamanhoSerie, c.seriesConfig.digitos, c.status]);
  }
  // Lojas: sincronizadas a cada boot (a relação oficial pode mudar até a véspera).
  for (const cnpj of campanhaPadrao.lojasParticipantesCNPJ) {
    await pool.query(
      'INSERT INTO loja_participante (campanha_id,cnpj) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [campanhaPadrao.id, cnpj]);
  }

  const u = await pool.query('SELECT id FROM usuario LIMIT 1');
  if (!u.rows.length) {
    if (!process.env.ADMIN_SENHA) throw new Error('ADMIN_SENHA não definida — necessária no primeiro boot.');
    await pool.query(
      `INSERT INTO usuario (id,nome,email,senha_hash,perfil,ativo) VALUES ($1,$2,$3,$4,$5,TRUE)`,
      ['U1', 'Administrador', process.env.ADMIN_EMAIL || 'marketing@shoppingaldeiadaserra.com.br',
       hashSenha(process.env.ADMIN_SENHA), 'ADMIN']);
  }
  return true;
}

// ---------- campanha ----------
async function getCampanha(cli, id, paraAtualizar) {
  const { rows } = await ex(cli).query(
    `SELECT * FROM campanha WHERE id = $1 ${paraAtualizar ? 'FOR UPDATE' : ''}`, [id]);
  if (!rows.length) return null;
  const r = rows[0];
  const lojas = await ex(cli).query('SELECT cnpj FROM loja_participante WHERE campanha_id = $1', [id]);
  const deny = await ex(cli).query('SELECT cpf_hash FROM denylist_cpf WHERE campanha_id = $1', [id]);
  return {
    id: r.id, nome: r.nome, valorUnidade: r.valor_unidade,
    qtdPremios: r.qtd_premios, qtdGanhadores: r.qtd_ganhadores,
    dataInicio: r.data_inicio, dataFim: r.data_fim, dataApuracao: r.data_apuracao,
    numCertificadoSPA: r.num_certificado_spa, acumulaSaldo: r.acumula_saldo,
    seriesConfig: {
      serieAtual: r.serie_atual, proximoNumero: r.proximo_numero,
      tamanhoSerie: r.tamanho_serie, digitos: r.digitos,
    },
    lojasParticipantesCNPJ: lojas.rows.map(x => x.cnpj),
    denylistCPFHash: deny.rows.map(x => x.cpf_hash),
    status: r.status,
  };
}

// ---------- participante ----------
function mapParticipante(r) {
  if (!r) return null;
  return {
    id: r.id, cpfHash: r.cpf_hash, cpf: decifra(r.cpf_enc),
    nome: r.nome, dataNascimento: r.data_nascimento,
    telefone: r.telefone, email: r.email, cidade: r.cidade, uf: r.uf,
    valorElegivelCents: r.valor_elegivel_cents,
    saldoRemanescenteCents: r.saldo_remanescente_cents,
    numerosAtivos: r.numeros_ativos, status: r.status, criadoEm: r.criado_em,
  };
}

async function getParticipantePorCpfHash(cli, cpfHash) {
  const { rows } = await ex(cli).query('SELECT * FROM participante WHERE cpf_hash = $1', [cpfHash]);
  return mapParticipante(rows[0]);
}
async function getParticipante(cli, id) {
  const { rows } = await ex(cli).query('SELECT * FROM participante WHERE id = $1', [id]);
  return mapParticipante(rows[0]);
}
async function listarParticipantes(cli) {
  const { rows } = await ex(cli).query('SELECT * FROM participante ORDER BY criado_em ASC');
  return rows.map(mapParticipante);
}
async function criarParticipante(cli, d) {
  const id = novoId('P');
  await ex(cli).query(
    `INSERT INTO participante (id,cpf_hash,cpf_enc,nome,data_nascimento,telefone,email,cidade,uf)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, d.cpfHash, cifra(d.cpf), d.nome, d.dataNascimento, d.telefone || null,
     d.email || null, d.cidade || null, d.uf || null]);
  return id;
}
async function registrarConsentimento(cli, participanteId, c) {
  await ex(cli).query(
    `INSERT INTO consentimento (participante_id,tipo,versao,aceito,ip,user_agent)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [participanteId, c.tipo, c.versao, c.aceito, c.ip || null, c.userAgent || null]);
}
async function atualizarTotais(cli, id, t) {
  await ex(cli).query(
    `UPDATE participante SET valor_elegivel_cents=$1, saldo_remanescente_cents=$2,
       numeros_ativos=$3, atualizado_em=now() WHERE id=$4`,
    [t.valorElegivelCents, t.saldoRemanescenteCents, t.numerosAtivos, id]);
}

// ---------- nota fiscal ----------
function mapNota(r) {
  if (!r) return null;
  return {
    id: r.id, campanhaId: r.campanha_id, participanteId: r.participante_id,
    chaveNfe: r.chave_nfe, cnpjEmitente: r.cnpj_emitente,
    valorTotalCents: r.valor_total_cents, valorElegivelCents: r.valor_elegivel_cents,
    dataCompra: r.data_compra, anoMesNota: r.ano_mes_nota, origem: r.origem,
    fotoUrl: r.foto_url, status: r.status, motivoRejeicao: r.motivo_rejeicao,
    analisadoPor: r.analisado_por, analisadoEm: r.analisado_em, criadoEm: r.criado_em,
  };
}
async function getNotaPorChave(cli, chave) {
  const { rows } = await ex(cli).query('SELECT * FROM nota_fiscal WHERE chave_nfe = $1', [chave]);
  return mapNota(rows[0]);
}
async function getNota(cli, id) {
  const { rows } = await ex(cli).query('SELECT * FROM nota_fiscal WHERE id = $1', [id]);
  return mapNota(rows[0]);
}
async function listarNotas(cli) {
  const { rows } = await ex(cli).query('SELECT * FROM nota_fiscal ORDER BY criado_em DESC');
  return rows.map(mapNota);
}
async function notasDoParticipante(cli, participanteId, status) {
  const { rows } = await ex(cli).query(
    `SELECT * FROM nota_fiscal WHERE participante_id = $1 ${status ? 'AND status = $2' : ''}
     ORDER BY criado_em ASC`,
    status ? [participanteId, status] : [participanteId]);
  return rows.map(mapNota);
}
async function criarNota(cli, n) {
  const id = novoId('NF');
  await ex(cli).query(
    `INSERT INTO nota_fiscal (id,campanha_id,participante_id,chave_nfe,cnpj_emitente,
       valor_total_cents,valor_elegivel_cents,data_compra,ano_mes_nota,origem,foto_url,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'EM_ANALISE')`,
    [id, n.campanhaId, n.participanteId, n.chaveNfe || null, n.cnpjEmitente || null,
     n.valorTotalCents, n.valorElegivelCents, n.dataCompra || null, n.anoMesNota || null,
     n.origem, n.fotoUrl || null]);
  return id;
}
async function salvarFoto(cli, notaId, { mime, buffer }) {
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  await ex(cli).query(
    `INSERT INTO nota_foto (nota_id,mime,bytes,tamanho,sha256) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (nota_id) DO NOTHING`,
    [notaId, mime, buffer, buffer.length, sha]);
  return sha;
}
async function getFoto(notaId) {
  const { rows } = await pool.query('SELECT mime, bytes FROM nota_foto WHERE nota_id = $1', [notaId]);
  return rows[0] ? { mime: rows[0].mime, bytes: rows[0].bytes } : null;
}

async function atualizarStatusNota(cli, id, s) {
  await ex(cli).query(
    `UPDATE nota_fiscal SET status=$1, motivo_rejeicao=$2, analisado_por=$3, analisado_em=now()
     WHERE id=$4`, [s.status, s.motivoRejeicao || null, s.analisadoPor || null, id]);
}

// ---------- auditoria (append-only, hash encadeado) ----------
// Chave do lock que serializa a escrita da trilha. Qualquer número serve, desde
// que seja o mesmo em todo o processo.
const LOCK_AUDITORIA = 4021977;

/**
 * Grava um evento na trilha, encadeado ao anterior.
 *
 * O lock é obrigatório, não um detalhe de performance: sem ele, duas requisições
 * simultâneas leem o MESMO "último hash" e gravam as duas apontando para ele —
 * a cadeia bifurca e a trilha inteira fica inválida para o auditor. Um FOR UPDATE
 * no último registro não resolve (não protege contra a linha nova que aparece no
 * meio), por isso o lock consultivo, que vale para a transação inteira.
 *
 * Como o lock só existe dentro de uma transação, auditar SEM transação abre uma.
 */
async function auditar(cli, evento) {
  if (!cli) return tx(c => auditarEm(c, evento));
  return auditarEm(cli, evento);
}

async function auditarEm(c, { entidade, entidadeId, acao, usuario, ip, userAgent, valorAnterior, valorNovo }) {
  await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_AUDITORIA]);
  const { rows } = await c.query('SELECT hash FROM auditoria ORDER BY id DESC LIMIT 1');
  const anterior = rows.length ? rows[0].hash : 'GENESIS';
  const base = JSON.stringify({ entidade, entidadeId, acao, usuario, ip, valorAnterior, valorNovo, anterior, t: Date.now() });
  const hash = crypto.createHash('sha256').update(base).digest('hex');
  await c.query(
    `INSERT INTO auditoria (entidade,entidade_id,acao,usuario,ip,user_agent,valor_anterior,valor_novo,hash_anterior,hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [entidade, entidadeId || null, acao, usuario || 'sistema', ip || null, userAgent || null,
     valorAnterior ? JSON.stringify(valorAnterior) : null,
     valorNovo ? JSON.stringify(valorNovo) : null, anterior, hash]);
  return hash;
}

async function verificarAuditoria() {
  const { rows } = await pool.query('SELECT id, hash_anterior, hash FROM auditoria ORDER BY id ASC');
  let anterior = 'GENESIS';
  for (const r of rows) {
    if (r.hash_anterior !== anterior) return { ok: false, quebrouEm: r.id };
    anterior = r.hash;
  }
  return { ok: true, total: rows.length };
}

async function listarAuditoria(limite) {
  const { rows } = await pool.query(
    'SELECT * FROM auditoria ORDER BY id DESC LIMIT $1', [limite || 200]);
  return rows.map(r => ({
    id: r.id, entidade: r.entidade, entidadeId: r.entidade_id, acao: r.acao,
    usuario: r.usuario, ip: r.ip, valorAnterior: r.valor_anterior, valorNovo: r.valor_novo,
    dataHora: r.data_hora, hashAnterior: r.hash_anterior, hash: r.hash,
  })).reverse();
}

/**
 * Verifica a cadeia de hash dos Números da Sorte na ordem real de emissão (seq).
 * É esta função que prova ao auditor que nenhum número foi inserido, alterado
 * ou removido no meio da cadeia.
 *
 * Faz DUAS conferências, porque uma só não basta:
 *  1. Elo: o hash_anterior de cada número aponta para o hash do número anterior.
 *     Pega inserção e remoção no meio da cadeia.
 *  2. Conteúdo: recalcula o hash a partir dos dados gravados. Sem isto, alguém
 *     poderia trocar o número sorteado mantendo os elos intactos.
 *
 * Limite honesto: quem tiver acesso de escrita ao banco E conhecer o algoritmo
 * ainda pode recalcular a cadeia inteira. O que sustenta a prova nesse caso é o
 * cruzamento com o snapshot_hash registrado na apuração e com a trilha de
 * auditoria — não a cadeia sozinha.
 */
async function verificarNumeros() {
  const { rows } = await pool.query(
    `SELECT n.seq, n.id, n.campanha_id, n.serie, n.numero, n.nota_origem_id, n.emitido_em,
            n.hash_anterior, n.hash_integridade, p.cpf_hash
     FROM numero_sorte n JOIN participante p ON p.id = n.participante_id
     ORDER BY n.seq ASC`);
  let anterior = 'GENESIS';
  for (const n of rows) {
    if (n.hash_anterior !== anterior) {
      return { ok: false, motivo: 'elo', quebrouEm: `${n.serie}-${n.numero}`, seq: n.seq, total: rows.length };
    }
    const recalc = core.hashNumero(
      n.hash_anterior, n.campanha_id, n.serie, n.numero, n.cpf_hash,
      n.nota_origem_id, new Date(n.emitido_em).toISOString());
    if (recalc !== n.hash_integridade) {
      return { ok: false, motivo: 'conteúdo alterado', quebrouEm: `${n.serie}-${n.numero}`, seq: n.seq, total: rows.length };
    }
    anterior = n.hash_integridade;
  }
  return { ok: true, total: rows.length };
}

// ---------- números da sorte ----------
function mapNumero(r) {
  return {
    id: r.id, seq: r.seq, campanhaId: r.campanha_id, serie: r.serie, numero: r.numero,
    participanteId: r.participante_id, notaOrigemId: r.nota_origem_id, status: r.status,
    emitidoEm: r.emitido_em, hashAnterior: r.hash_anterior, hashIntegridade: r.hash_integridade,
  };
}
async function numerosDoParticipante(cli, participanteId, status) {
  const { rows } = await ex(cli).query(
    `SELECT * FROM numero_sorte WHERE participante_id = $1 ${status ? 'AND status = $2' : ''}
     ORDER BY seq ASC`, status ? [participanteId, status] : [participanteId]);
  return rows.map(mapNumero);
}
async function numerosAtivos(cli) {
  const { rows } = await ex(cli).query(
    "SELECT * FROM numero_sorte WHERE status = 'ATIVO' ORDER BY seq ASC");
  return rows.map(mapNumero);
}
async function contarNumeros(cli, status) {
  const { rows } = await ex(cli).query(
    'SELECT count(*)::bigint AS n FROM numero_sorte WHERE status = $1', [status]);
  return rows[0].n;
}

/**
 * Emite N números dentro de UMA transação, travando a linha da campanha
 * (SELECT ... FOR UPDATE) para que dois pedidos simultâneos não peguem o mesmo número.
 * O índice UNIQUE do banco é a segunda barreira: se algo escapar, a transação falha.
 */
async function emitirNumeros(cli, { campanhaId, participanteId, cpfHash, notaOrigemId, quantidade }) {
  const { rows: cRows } = await cli.query(
    'SELECT serie_atual, proximo_numero, tamanho_serie, digitos FROM campanha WHERE id = $1 FOR UPDATE',
    [campanhaId]);
  if (!cRows.length) throw new Error('Campanha não encontrada.');
  let { serie_atual: serie, proximo_numero: prox, tamanho_serie: tam, digitos } = cRows[0];

  // Último elo da cadeia: ordenar por seq (monotônico). Nunca por id (aleatório) nem
  // por emitido_em (dois números no mesmo milissegundo tornariam a ordem ambígua e
  // quebrariam a cadeia de hash).
  const { rows: hRows } = await cli.query(
    'SELECT hash_integridade FROM numero_sorte ORDER BY seq DESC LIMIT 1');
  let anterior = hRows.length ? hRows[0].hash_integridade : 'GENESIS';

  const emitidos = [];
  for (let i = 0; i < quantidade; i++) {
    if (prox >= tam) { serie += 1; prox = 0; }              // estouro de série
    const s = String(serie).padStart(2, '0');
    const n = String(prox).padStart(digitos, '0');
    const emitidoEm = new Date().toISOString();
    const id = novoId('NUM');
    const hash = core.hashNumero(anterior, campanhaId, s, n, cpfHash, notaOrigemId, emitidoEm);
    await cli.query(
      `INSERT INTO numero_sorte (id,campanha_id,serie,numero,participante_id,nota_origem_id,status,
         emitido_em,hash_anterior,hash_integridade)
       VALUES ($1,$2,$3,$4,$5,$6,'ATIVO',$7,$8,$9)`,
      [id, campanhaId, s, n, participanteId, notaOrigemId, emitidoEm, anterior, hash]);
    await cli.query(
      `INSERT INTO numero_sorte_historico (numero_id,status_anterior,status_novo,motivo,usuario)
       VALUES ($1,NULL,'ATIVO',$2,'sistema')`, [id, `Emissão a partir da nota ${notaOrigemId}`]);
    emitidos.push({ id, serie: s, numero: n });
    anterior = hash;
    prox += 1;
  }
  await cli.query('UPDATE campanha SET serie_atual=$1, proximo_numero=$2 WHERE id=$3', [serie, prox, campanhaId]);
  return emitidos;
}

async function inutilizarNumeros(cli, { participanteId, quantidade, motivo, usuario, ip }) {
  const { rows } = await cli.query(
    `SELECT id, serie, numero FROM numero_sorte WHERE participante_id=$1 AND status='ATIVO'
     ORDER BY seq DESC LIMIT $2 FOR UPDATE`, [participanteId, quantidade]);
  for (const r of rows) {
    await cli.query("UPDATE numero_sorte SET status='INUTILIZADO' WHERE id=$1", [r.id]);
    await cli.query(
      `INSERT INTO numero_sorte_historico (numero_id,status_anterior,status_novo,motivo,usuario,ip)
       VALUES ($1,'ATIVO','INUTILIZADO',$2,$3,$4)`, [r.id, motivo, usuario || 'sistema', ip || null]);
  }
  return rows.map(r => ({ id: r.id, serie: r.serie, numero: r.numero }));
}

// ---------- sorteio ----------
async function criarSorteio(cli, s) {
  const id = novoId('SORT');
  await cli.query(
    `INSERT INTO sorteio (id,campanha_id,resultado_loteria,snapshot_hash,executado_por)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, s.campanhaId, JSON.stringify(s.resultadoLoteria), s.snapshotHash, s.executadoPor || null]);
  return id;
}
async function criarGanhador(cli, sorteioId, g) {
  await cli.query(
    `INSERT INTO ganhador (id,sorteio_id,premio_ordem,numero_alvo,regra,numero_id,participante_id,tipo,status,motivo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [novoId('G'), sorteioId, g.premioOrdem, g.numeroAlvo, g.regra, g.numeroId || null,
     g.participanteId || null, g.tipo || 'TITULAR', g.status, g.motivo || null]);
}

// ---------- usuário admin ----------
async function getUsuarioPorEmail(cli, email) {
  const { rows } = await ex(cli).query(
    'SELECT * FROM usuario WHERE lower(email) = lower($1) AND ativo = TRUE', [email]);
  const r = rows[0];
  return r ? { id: r.id, nome: r.nome, email: r.email, senhaHash: r.senha_hash,
               perfil: r.perfil, mfaSecret: r.mfa_secret, mfaAtivo: r.mfa_ativo } : null;
}

/**
 * Lista para o SCPC (Nota 23): número ativo + dados do participante, com o CPF
 * decifrado. Um JOIN só — a lista pode ter dezenas de milhares de linhas e não
 * cabe fazer uma consulta por número.
 */
async function listaSCPC() {
  const { rows } = await pool.query(
    `SELECT n.serie, n.numero, n.emitido_em, p.cpf_enc, p.nome, p.email, p.telefone
     FROM numero_sorte n JOIN participante p ON p.id = n.participante_id
     WHERE n.status = 'ATIVO' ORDER BY n.seq ASC`);
  return rows.map(r => ({
    serie: r.serie, numero: r.numero, emitidoEm: r.emitido_em,
    cpf: decifra(r.cpf_enc), nome: r.nome, email: r.email, telefone: r.telefone,
  }));
}

module.exports = {
  pool, q, tx, init,
  getCampanha,
  getParticipante, getParticipantePorCpfHash, listarParticipantes, criarParticipante,
  registrarConsentimento, atualizarTotais,
  getNota, getNotaPorChave, listarNotas, notasDoParticipante, criarNota, atualizarStatusNota,
  salvarFoto, getFoto,
  numerosDoParticipante, numerosAtivos, contarNumeros, emitirNumeros, inutilizarNumeros,
  criarSorteio, criarGanhador,
  getUsuarioPorEmail, listaSCPC,
  auditar, verificarAuditoria, listarAuditoria, verificarNumeros,
  cifra, decifra, hashSenha, conferirSenha,
};
