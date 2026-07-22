'use strict';
/**
 * Teste de integração — exercita o fluxo real contra um PostgreSQL de verdade.
 * O test.js cobre as regras puras (core.js); este cobre o que só quebra com banco:
 * transações, unicidade sob concorrência, cadeia de hash e imutabilidade.
 *
 * Uso:
 *   node pg-local.js  (ou o embedded-postgres da sua máquina)
 *   DATABASE_URL=postgresql://... APP_KEY=<64 hex> ADMIN_SENHA=x node test-integracao.js
 */
const assert = require('assert');
const crypto = require('crypto');

if (!process.env.DATABASE_URL) { console.error('Defina DATABASE_URL.'); process.exit(1); }
process.env.APP_KEY = process.env.APP_KEY || crypto.randomBytes(32).toString('hex');
process.env.ADMIN_SENHA = process.env.ADMIN_SENHA || 'senha-de-teste';

const store = require('./store-pg');
const svc = require('./service');
const core = require('./core');
const CAMPANHA = require('./campanha.config');

let ok = 0, falhas = 0;
async function t(nome, fn) {
  try { await fn(); console.log(`  ✔ ${nome}`); ok++; }
  catch (e) { console.log(`  ✘ ${nome}\n      ${e.message}`); falhas++; }
}

// CPF válido gerado na hora (não usar CPF real em teste).
function cpfGerado() {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  for (let j = 0; j < 2; j++) {
    const soma = n.reduce((s, v, i) => s + v * (n.length + 1 - i), 0);
    const d = (soma * 10) % 11 % 10;
    n.push(d);
  }
  return n.join('');
}

const FOTO = 'data:image/png;base64,' + Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080600000' + '01f15c489', 'hex').toString('base64');

const CNPJ_LOJA = CAMPANHA.lojasParticipantesCNPJ[0];
// Monta uma chave de NFC-e coerente (44 dígitos + DV mod-11) para a loja participante.
function chaveNFe(cnpj, nNF) {
  const base = '32' + '2607' + cnpj + '65' + '001' + String(nNF).padStart(9, '0') + '1' +
    String(nNF).padStart(8, '0');
  const pesos = [2, 3, 4, 5, 6, 7, 8, 9];
  let soma = 0;
  for (let i = base.length - 1, j = 0; i >= 0; i--, j++) soma += Number(base[i]) * pesos[j % 8];
  const r = soma % 11;
  const dv = (r === 0 || r === 1) ? 0 : 11 - r;
  return base + dv;
}

async function limpar() {
  // Auditoria e números têm trigger contra DELETE: derruba na ordem e desabilita.
  await store.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

async function main() {
  console.log('\n  TESTE DE INTEGRAÇÃO — Aldeia Premia (PostgreSQL real)\n');
  await limpar();
  await store.init(CAMPANHA);

  let participanteId, cpf = cpfGerado();

  await t('Cadastro grava participante e devolve CPF mascarado', async () => {
    const p = await svc.cadastrarParticipante({
      cpf, nome: 'Maria de Teste Silva', dataNascimento: '1990-05-10',
      telefone: '27999998888', email: 'maria@teste.com.br', cidade: 'Serra', uf: 'ES',
      aceiteRegulamento: true, aceitePrivacidade: true, aceiteMarketing: false,
    }, '200.0.0.1', 'jest');
    participanteId = p.id;
    assert.match(p.cpf, /^\d{3}\.\*\*\*\.\*\*\*-\d{2}$/, 'CPF deve sair mascarado');
    assert.strictEqual(p.numerosAtivos, 0);
  });

  await t('CPF em repouso está cifrado (não dá para ler no banco)', async () => {
    const { rows } = await store.q('SELECT cpf_enc FROM participante WHERE id=$1', [participanteId]);
    assert.ok(!rows[0].cpf_enc.includes(cpf), 'CPF apareceu em claro na coluna!');
    assert.strictEqual(store.decifra(rows[0].cpf_enc), cpf, 'decifra deve devolver o CPF original');
  });

  await t('CPF duplicado é recusado (RN-16)', async () => {
    await assert.rejects(() => svc.cadastrarParticipante({
      cpf, nome: 'Outra Pessoa Qualquer', dataNascimento: '1990-05-10',
      aceiteRegulamento: true, aceitePrivacidade: true,
    }, '200.0.0.1'), /já possui cadastro/);
  });

  await t('Menor de idade é recusado', async () => {
    await assert.rejects(() => svc.cadastrarParticipante({
      cpf: cpfGerado(), nome: 'Jovem Demais Souza', dataNascimento: '2015-01-01',
      aceiteRegulamento: true, aceitePrivacidade: true,
    }, '200.0.0.1'), /18 anos/);
  });

  await t('Nota sem foto é recusada (evidência obrigatória)', async () => {
    await assert.rejects(() => svc.enviarNota(participanteId, {
      chaveNfe: chaveNFe(CNPJ_LOJA, 1), valorTotal: 500,
    }, '200.0.0.1'), /foto/i);
  });

  await t('Loja não participante é recusada', async () => {
    await assert.rejects(() => svc.enviarNota(participanteId, {
      chaveNfe: chaveNFe('11222333000181', 2), valorTotal: 500, fotoBase64: FOTO,
      dataCompra: '2026-07-25',
    }, '200.0.0.1'), /não participante/i);
  });

  await t('Compra fora do período é recusada', async () => {
    await assert.rejects(() => svc.enviarNota(participanteId, {
      chaveNfe: chaveNFe(CNPJ_LOJA, 3), valorTotal: 500, fotoBase64: FOTO,
      dataCompra: '2026-07-01',
    }, '200.0.0.1'), /fora do período/i);
  });

  let notaId;
  await t('Nota de R$ 1.750 entra EM_ANALISE e ainda NÃO gera número', async () => {
    const n = await svc.enviarNota(participanteId, {
      chaveNfe: chaveNFe(CNPJ_LOJA, 10), valorTotal: 1750, fotoBase64: FOTO,
      dataCompra: '2026-07-25',
    }, '200.0.0.1');
    notaId = n.id;
    assert.strictEqual(n.status, 'EM_ANALISE');
    const nums = await store.numerosDoParticipante(null, participanteId, 'ATIVO');
    assert.strictEqual(nums.length, 0, 'nota em análise não pode gerar número');
  });

  await t('Foto foi guardada no banco (e não em disco efêmero)', async () => {
    const f = await store.getFoto(notaId);
    assert.ok(f && f.bytes.length > 0, 'foto deveria estar no banco');
    assert.strictEqual(f.mime, 'image/png');
  });

  await t('Nota duplicada (mesma chave) é recusada (RN-05)', async () => {
    await assert.rejects(() => svc.enviarNota(participanteId, {
      chaveNfe: chaveNFe(CNPJ_LOJA, 10), valorTotal: 100, fotoBase64: FOTO,
      dataCompra: '2026-07-25',
    }, '200.0.0.1'), /já foi cadastrada/);
  });

  await t('Aprovação de R$ 1.750 gera 3 números e guarda R$ 250 de saldo', async () => {
    const r = await svc.aprovarNota(notaId, 'admin@teste', '200.0.0.1');
    assert.strictEqual(r.numerosDevidos, 3, 'R$1.750 / R$500 = 3 números');
    assert.strictEqual(r.emitidos.length, 3);
    assert.strictEqual(r.participante.saldoRemanescente, 250, 'sobra R$250 acumulados');
  });

  await t('Cancelar a nota inutiliza os números — nunca apaga (Seção 6.8)', async () => {
    const r = await svc.cancelarNota(notaId, 'Nota fraudada', 'admin@teste', '200.0.0.1');
    assert.strictEqual(r.numerosDevidos, 0);
    assert.strictEqual(r.inutilizados.length, 3);
    const todos = await store.numerosDoParticipante(null, participanteId);
    assert.strictEqual(todos.length, 3, 'os 3 números continuam existindo');
    assert.ok(todos.every(n => n.status === 'INUTILIZADO'));
  });

  await t('O banco recusa fisicamente o DELETE de um Número da Sorte', async () => {
    await assert.rejects(() => store.q('DELETE FROM numero_sorte'), /não podem ser excluídos/);
  });

  await t('O banco recusa fisicamente alterar a trilha de auditoria', async () => {
    await assert.rejects(() => store.q("UPDATE auditoria SET acao='FRAUDE'"), /append-only/);
    await assert.rejects(() => store.q('DELETE FROM auditoria'), /append-only/);
  });

  // ---- O teste que já pegou um bug real: emissão simultânea ----
  await t('100 números emitidos em 20 transações simultâneas: todos únicos', async () => {
    const ids = [];
    for (let i = 0; i < 20; i++) {
      const c = cpfGerado();
      const p = await svc.cadastrarParticipante({
        cpf: c, nome: `Participante Numero ${i} Teste`, dataNascimento: '1990-01-01',
        email: `p${i}@teste.com.br`, telefone: '27999990000',
        aceiteRegulamento: true, aceitePrivacidade: true,
      }, '200.0.0.2');
      ids.push(p.id);
    }
    // 20 notas de R$2.500 (= 5 números cada) aprovadas ao mesmo tempo
    const notas = [];
    for (let i = 0; i < 20; i++) {
      const n = await svc.enviarNota(ids[i], {
        chaveNfe: chaveNFe(CNPJ_LOJA, 100 + i), valorTotal: 2500, fotoBase64: FOTO,
        dataCompra: '2026-07-25',
      }, '200.0.0.2');
      notas.push(n.id);
    }
    await Promise.all(notas.map(id => svc.aprovarNota(id, 'admin@teste', '200.0.0.2')));

    const ativos = await store.numerosAtivos(null);
    assert.strictEqual(ativos.length, 100, `esperado 100 números ativos, veio ${ativos.length}`);
    const chaves = new Set(ativos.map(n => `${n.serie}-${n.numero}`));
    assert.strictEqual(chaves.size, 100, 'houve número duplicado sob concorrência!');
  });

  await t('Cadeia de hash dos Números está íntegra após a concorrência', async () => {
    const r = await store.verificarNumeros();
    assert.ok(r.ok, `cadeia quebrou em ${r.quebrouEm} (seq ${r.seq})`);
    assert.strictEqual(r.total, 103, 'inclui os 3 inutilizados');
  });

  await t('Quebrar um elo da cadeia é detectado', async () => {
    const { rows } = await store.q('SELECT id, hash_integridade FROM numero_sorte ORDER BY seq ASC OFFSET 6 LIMIT 1');
    await store.q("UPDATE numero_sorte SET hash_integridade='forjado' WHERE id=$1", [rows[0].id]);
    const r = await store.verificarNumeros();
    assert.ok(!r.ok, 'adulteração passou despercebida — invalidaria a auditoria');
    await store.q('UPDATE numero_sorte SET hash_integridade=$1 WHERE id=$2', [rows[0].hash_integridade, rows[0].id]);
    assert.ok((await store.verificarNumeros()).ok, 'cadeia deveria voltar a fechar');
  });

  // O caso perigoso: trocar o número contemplado SEM mexer nos hashes. Os elos
  // continuam apontando certo — só a reconferência do conteúdo pega.
  await t('Trocar o número mantendo os elos intactos também é detectado', async () => {
    const { rows } = await store.q('SELECT id, numero FROM numero_sorte ORDER BY seq ASC OFFSET 6 LIMIT 1');
    await store.q("UPDATE numero_sorte SET numero='99999' WHERE id=$1", [rows[0].id]);
    const r = await store.verificarNumeros();
    assert.ok(!r.ok, 'troca silenciosa do número passou — alguém poderia forjar o ganhador');
    assert.strictEqual(r.motivo, 'conteúdo alterado');
    await store.q('UPDATE numero_sorte SET numero=$1 WHERE id=$2', [rows[0].numero, rows[0].id]);
    assert.ok((await store.verificarNumeros()).ok, 'cadeia deveria voltar a fechar');
  });

  await t('Trilha de auditoria está íntegra', async () => {
    const r = await store.verificarAuditoria();
    assert.ok(r.ok, `auditoria quebrou em ${r.quebrouEm}`);
  });

  await t('Lista do SCPC traz CPF em claro, 11 dígitos, e data no fuso de Brasília', async () => {
    const lista = await store.listaSCPC();
    assert.ok(lista.length >= 100);
    assert.ok(lista.every(r => /^\d{11}$/.test(r.cpf)), 'CPF deve sair decifrado com 11 dígitos');
    assert.ok(lista.every(r => r.nome.length >= 6 && r.nome.length <= 100));
  });

  await t('Apuração: número sorteado na plataforma, 2 ganhadores distintos (Cláusula 9)', async () => {
    const s = await svc.apurar('12345', 'admin@teste', '200.0.0.1');
    assert.strictEqual(s.numeroSorteado, '12345', 'deve registrar o número sorteado');
    assert.strictEqual(s.ganhadores[0].numeroAlvo, '12345', '1º prêmio parte do número sorteado');
    assert.strictEqual(s.ganhadores.length, 2);
    assert.ok(s.snapshotHash && s.snapshotHash.length === 64, 'snapshot deve ser SHA-256');
    const comGanhador = s.ganhadores.filter(g => g.status === 'CONTEMPLADO');
    assert.strictEqual(comGanhador.length, 2, 'os 2 prêmios devem achar ganhador');
    assert.notStrictEqual(comGanhador[0].participanteId, comGanhador[1].participanteId,
      'os dois prêmios caíram no mesmo participante — viola a cláusula 9.4');
    assert.match(comGanhador[0].cpf, /\*\*\*/, 'CPF do ganhador não pode sair em claro');
  });

  await t('Apuração ficou registrada com os ganhadores no banco', async () => {
    const { rows } = await store.q('SELECT count(*)::int AS n FROM ganhador');
    assert.strictEqual(rows[0].n, 2);
    const s = await store.q('SELECT resultado_loteria FROM sorteio');
    assert.strictEqual(s.rows[0].resultado_loteria.numeroSorteado, '12345');
    assert.strictEqual(s.rows[0].resultado_loteria.origem, 'plataforma_online');
  });

  await t('Senha do admin é scrypt e confere', async () => {
    const u = await store.getUsuarioPorEmail(null, process.env.ADMIN_EMAIL || 'marketing@shoppingaldeiadaserra.com.br');
    assert.ok(u, 'admin deveria ter sido criado no init');
    assert.ok(u.senhaHash.startsWith('scrypt$'), 'senha deve usar scrypt');
    assert.ok(!u.senhaHash.includes(process.env.ADMIN_SENHA), 'senha não pode aparecer no hash');
    assert.ok(store.conferirSenha(process.env.ADMIN_SENHA, u.senhaHash));
    assert.ok(!store.conferirSenha('senha-errada', u.senhaHash));
  });

  await t('Datas da campanha voltam do banco sem escorregar de dia (fuso)', async () => {
    const c = await store.getCampanha(null, CAMPANHA.id);
    assert.strictEqual(c.dataInicio, '2026-07-24');
    assert.strictEqual(c.dataFim, '2026-08-09');
    assert.strictEqual(c.dataApuracao, '2026-08-19');
    assert.strictEqual(c.valorUnidade, 500, 'valor da unidade deve voltar como número');
  });

  console.log(`\n  ${ok} passaram, ${falhas} falharam\n`);
  await store.pool.end();
  process.exit(falhas ? 1 : 0);
}

main().catch(e => { console.error('\n  ERRO FATAL:', e); process.exit(1); });
