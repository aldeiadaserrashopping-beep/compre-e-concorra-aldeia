'use strict';
/**
 * Teste de integração do COMPRE E GANHE (Natal 2026), contra Postgres real.
 *
 * Cobre o que, se falhar em dezembro, custa caro: dar dois panettones ao mesmo
 * CPF, entregar além do estoque, aceitar nota de praça de alimentação, ou somar
 * notas da campanha das bicicletas no acumulado do Natal.
 *
 * Uso: DATABASE_URL=... APP_KEY=... ADMIN_SENHA=... node test-natal.js
 */
const store = require('./store-pg');
const svc = require('./service');
const core = require('./core');
const CAMPANHA = require('./campanha.config');

let passou = 0, falhou = 0;
const casos = [];
const teste = (nome, fn) => casos.push({ nome, fn });

function ok(cond, detalhe) {
  if (!cond) throw new Error(detalhe || 'condição falsa');
}
async function esperaErro(fn, codigo) {
  try { await fn(); } catch (e) {
    if (codigo && e.codigo !== codigo)
      throw new Error(`esperava ${codigo}, veio ${e.codigo} (${e.message})`);
    return e;
  }
  throw new Error(`esperava erro ${codigo || ''} e nada falhou`);
}

// --------------------------------------------------------------- utilidades
const FOTO = 'data:image/png;base64,' + Buffer.from(
  '\x89PNG\r\n\x1a\n' + 'x'.repeat(200)).toString('base64');

let seqCpf = 0;
/** Gera um CPF válido e distinto a cada chamada. */
function cpfValido() {
  seqCpf += 1;
  const base = String(100000000 + seqCpf).padStart(9, '0');
  const d = base.split('').map(Number);
  const dv = (nums) => {
    const peso = nums.length + 1;
    const s = nums.reduce((acc, n, i) => acc + n * (peso - i), 0);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(d);
  const d2 = dv([...d, d1]);
  return base + d1 + d2;
}

async function novoParticipante(nome) {
  const cpf = cpfValido();
  const p = await svc.cadastrarParticipante({
    cpf, nome, dataNascimento: '1990-05-10',
    telefone: '27999990000', email: `${cpf}@teste.local`,
    aceiteRegulamento: true, aceitePrivacidade: true,
  }, '127.0.0.1', 'teste');
  return { ...p, cpfLimpo: cpf };
}

/** Envia e já aprova uma nota — atalho para montar cenários. */
async function notaAprovada(participanteId, valor, cnpj, data) {
  const n = await svc.enviarNota(participanteId, {
    valorTotal: valor, cnpjEmitente: cnpj || '62506724000169',
    dataCompra: data || '2026-12-10', fotoBase64: FOTO,
  }, '127.0.0.1', 'teste');
  return svc.aprovarNota(n.id, 'teste@aldeia', '127.0.0.1');
}

// ------------------------------------------------------------------ casos

teste('Campanha de Natal sobe na modalidade compre e ganhe', async () => {
  const c = await store.getCampanha(null, CAMPANHA.id);
  ok(c, 'campanha não foi criada');
  ok(c.modalidade === 'COMPRE_GANHE', `modalidade veio ${c.modalidade}`);
  ok(c.valorMinimoCents === 30000, `mínimo veio ${c.valorMinimoCents}`);
  ok(c.estoqueTotal === 300, `estoque veio ${c.estoqueTotal}`);
  ok(c.limitePorCpf === 1, 'limite por CPF deveria ser 1');
});

teste('Só as 12 lojas de varejo estão cadastradas', async () => {
  const c = await store.getCampanha(null, CAMPANHA.id);
  ok(c.lojasParticipantesCNPJ.length === 12, `vieram ${c.lojasParticipantesCNPJ.length} lojas`);
  // Praça de alimentação e serviços não podem estar na lista (Cláusula 5).
  for (const fora of ['59273034000100', '59302709000194', '13305908000155', '15743430000251']) {
    ok(!c.lojasParticipantesCNPJ.includes(fora), `${fora} não deveria participar`);
  }
});

teste('Abaixo de R$ 300 não gera direito ao brinde', async () => {
  const p = await novoParticipante('Cliente Abaixo Do Minimo');
  const r = await notaAprovada(p.id, 299.99);
  ok(r.direito === null, 'não deveria ter direito com R$ 299,99');
  ok(r.faltamCents === 1, `faltam deveria ser 1 centavo, veio ${r.faltamCents}`);
});

teste('Ao atingir R$ 300 o participante é qualificado', async () => {
  const p = await novoParticipante('Cliente Exatamente No Minimo');
  const r = await notaAprovada(p.id, 300.00);
  ok(r.direito, 'deveria ter direito ao brinde');
  ok(r.direito.status === 'QUALIFICADO', `status veio ${r.direito.status}`);
  ok(r.acao === 'QUALIFICADO', `ação veio ${r.acao}`);
});

teste('Notas de lojas diferentes somam (Cláusula 6)', async () => {
  const p = await novoParticipante('Cliente Somando Lojas');
  await notaAprovada(p.id, 150.00, '62506724000169');   // Cacau Show
  const r = await notaAprovada(p.id, 150.00, '03756360000106'); // O Boticário
  ok(r.direito && r.direito.status === 'QUALIFICADO', 'duas lojas deveriam somar R$ 300');
});

teste('Acima de R$ 300 continua sendo 1 brinde só (Cláusula 8)', async () => {
  const p = await novoParticipante('Cliente Comprou Novecentos');
  await notaAprovada(p.id, 450.00);
  await notaAprovada(p.id, 450.00);
  const { rows } = await store.q(
    'SELECT count(*)::int c FROM brinde_direito WHERE campanha_id=$1 AND participante_id=$2',
    [CAMPANHA.id, p.id]);
  ok(rows[0].c === 1, `R$ 900 gerou ${rows[0].c} direitos; deveria gerar 1`);
});

teste('Nota de praça de alimentação é recusada', async () => {
  const p = await novoParticipante('Cliente Comprou No Spoleto');
  await esperaErro(() => svc.enviarNota(p.id, {
    valorTotal: 500, cnpjEmitente: '59273034000100',  // Ask Spoleto
    dataCompra: '2026-12-10', fotoBase64: FOTO,
  }, '127.0.0.1', 'teste'), 'E-NOTA-04');
});

teste('Nota de academia (serviço) é recusada', async () => {
  const p = await novoParticipante('Cliente Pagou A Academia');
  await esperaErro(() => svc.enviarNota(p.id, {
    valorTotal: 500, cnpjEmitente: '13305908000155',  // Smart Fit
    dataCompra: '2026-12-10', fotoBase64: FOTO,
  }, '127.0.0.1', 'teste'), 'E-NOTA-04');
});

teste('Nota de novembro (antes da campanha) é recusada', async () => {
  const p = await novoParticipante('Cliente Comprou Antes');
  await esperaErro(() => svc.enviarNota(p.id, {
    valorTotal: 500, cnpjEmitente: '62506724000169',
    dataCompra: '2026-11-28', fotoBase64: FOTO,
  }, '127.0.0.1', 'teste'), 'E-NOTA-03');
});

teste('Nota rejeitada depois revoga o direito ainda não retirado', async () => {
  const p = await novoParticipante('Cliente Teve Nota Recusada');
  await notaAprovada(p.id, 100.00);
  const segunda = await svc.enviarNota(p.id, {
    valorTotal: 250.00, cnpjEmitente: '62506724000169',
    dataCompra: '2026-12-12', fotoBase64: FOTO,
  }, '127.0.0.1', 'teste');
  const depois = await svc.aprovarNota(segunda.id, 'teste@aldeia', '127.0.0.1');
  ok(depois.direito.status === 'QUALIFICADO', 'deveria qualificar com R$ 350');

  const r = await svc.rejeitarNota(segunda.id, 'Nota ilegível', 'teste@aldeia', '127.0.0.1');
  ok(r.direito.status === 'REVOGADO', `após rejeitar, status veio ${r.direito.status}`);
  ok(r.acao === 'REVOGADO', `ação veio ${r.acao}`);
});

teste('Entrega marca como retirado e baixa o estoque', async () => {
  const p = await novoParticipante('Cliente Vai Retirar');
  const r = await notaAprovada(p.id, 320.00);
  const antes = await store.contarBrindes(CAMPANHA.id);
  const e = await svc.entregarBrinde({
    direitoId: r.direito.id, atendente: 'atendente@aldeia',
    documentoConferido: 'RG 1.234.567 SSP/ES',
  }, '127.0.0.1');
  ok(e.direito.status === 'RETIRADO', `status veio ${e.direito.status}`);
  ok(e.estoque.retirados === antes.retirados + 1, 'estoque não baixou');
});

teste('O mesmo CPF não retira duas vezes (Cláusula 8)', async () => {
  const p = await novoParticipante('Cliente Tentou Duas Vezes');
  const r = await notaAprovada(p.id, 300.00);
  await svc.entregarBrinde({
    direitoId: r.direito.id, atendente: 'atendente@aldeia', documentoConferido: 'CNH',
  }, '127.0.0.1');
  await esperaErro(() => svc.entregarBrinde({
    direitoId: r.direito.id, atendente: 'atendente@aldeia', documentoConferido: 'CNH',
  }, '127.0.0.1'), 'E-BRD-02');
});

teste('Quem não atingiu o mínimo não consegue retirar', async () => {
  const p = await novoParticipante('Cliente Insistente No Balcao');
  await notaAprovada(p.id, 50.00);
  const consulta = await svc.consultarCpf(p.cpfLimpo);
  ok(consulta.direito === null, 'não deveria haver direito');
  ok(consulta.faltam === 250, `faltam veio ${consulta.faltam}`);
});

teste('Entrega exige registro do documento conferido', async () => {
  const p = await novoParticipante('Cliente Sem Documento');
  const r = await notaAprovada(p.id, 300.00);
  await esperaErro(() => svc.entregarBrinde({
    direitoId: r.direito.id, atendente: 'atendente@aldeia',
  }, '127.0.0.1'), 'E-BRD-06');
});

teste('Estoque esgotado impede a entrega seguinte', async () => {
  // Reduz o estoque ao que já foi entregue: o próximo tem de ser recusado.
  const atual = await store.contarBrindes(CAMPANHA.id);
  await store.q('UPDATE campanha SET estoque_total = $1 WHERE id = $2',
    [atual.retirados, CAMPANHA.id]);
  try {
    const p = await novoParticipante('Cliente Chegou Tarde');
    const r = await notaAprovada(p.id, 300.00);
    await esperaErro(() => svc.entregarBrinde({
      direitoId: r.direito.id, atendente: 'atendente@aldeia', documentoConferido: 'RG',
    }, '127.0.0.1'), 'E-BRD-04');
  } finally {
    await store.q('UPDATE campanha SET estoque_total = 300 WHERE id = $1', [CAMPANHA.id]);
  }
});

teste('Duas entregas simultâneas não furam o estoque', async () => {
  // Deixa exatamente 1 unidade e dispara duas entregas ao mesmo tempo:
  // uma tem de passar, a outra tem de ser recusada.
  const atual = await store.contarBrindes(CAMPANHA.id);
  await store.q('UPDATE campanha SET estoque_total = $1 WHERE id = $2',
    [atual.retirados + 1, CAMPANHA.id]);
  try {
    const a = await novoParticipante('Cliente Simultaneo Um');
    const b = await novoParticipante('Cliente Simultaneo Dois');
    const ra = await notaAprovada(a.id, 300.00);
    const rb = await notaAprovada(b.id, 300.00);

    const res = await Promise.allSettled([
      svc.entregarBrinde({ direitoId: ra.direito.id, atendente: 'at1', documentoConferido: 'RG' }, '1.1.1.1'),
      svc.entregarBrinde({ direitoId: rb.direito.id, atendente: 'at2', documentoConferido: 'RG' }, '2.2.2.2'),
    ]);
    const okN = res.filter(x => x.status === 'fulfilled').length;
    ok(okN === 1, `${okN} entregas passaram; deveria passar exatamente 1`);

    const depois = await store.contarBrindes(CAMPANHA.id);
    ok(depois.retirados === atual.retirados + 1,
      `entregues ${depois.retirados}, esperado ${atual.retirados + 1}`);
  } finally {
    await store.q('UPDATE campanha SET estoque_total = 300 WHERE id = $1', [CAMPANHA.id]);
  }
});

teste('Notas da campanha anterior não contam para o Natal', async () => {
  const p = await novoParticipante('Cliente Veterano Das Bicicletas');
  // Simula uma nota da campanha das bicicletas, já aprovada.
  await store.q(
    `INSERT INTO campanha (id,nome,valor_unidade,qtd_premios,qtd_ganhadores,data_inicio,data_fim,status,modalidade)
     VALUES ('CAMP-ANTIGA','Campanha anterior',500,2,2,'2026-07-24','2026-08-09','ENCERRADA','SORTEIO')
     ON CONFLICT DO NOTHING`);
  await store.q(
    `INSERT INTO nota_fiscal (id,campanha_id,participante_id,cnpj_emitente,valor_total_cents,
       valor_elegivel_cents,data_compra,origem,status)
     VALUES ('NF-ANTIGA-1','CAMP-ANTIGA',$1,'62506724000169',99900,99900,'2026-08-01','FOTO','APROVADA')`,
    [p.id]);

  const consulta = await svc.consultarCpf(p.cpfLimpo);
  ok(consulta.valorElegivel === 0,
    `acumulado do Natal deveria ser 0, veio ${consulta.valorElegivel}`);
  ok(consulta.direito === null, 'não deveria ter direito a brinde pelo histórico antigo');
});

teste('Trilha de auditoria continua íntegra', async () => {
  const r = await store.verificarAuditoria();
  ok(r.ok, `cadeia quebrou em ${r.quebrouEm}`);
});

teste('Consulta por CPF devolve o que o balcão precisa', async () => {
  const p = await novoParticipante('Cliente Para Conferencia');
  await notaAprovada(p.id, 310.00);
  const c = await svc.consultarCpf(p.cpfLimpo);
  ok(c.participante.nome === 'Cliente Para Conferencia', 'nome errado');
  ok(/^\d{3}\.\*\*\*\.\*\*\*-\d{2}$/.test(c.participante.cpf), `CPF não mascarado: ${c.participante.cpf}`);
  ok(c.direito && c.direito.status === 'QUALIFICADO', 'deveria estar qualificado');
  ok(c.notas.length === 1 && c.notas[0].loja === 'Cacau Show', 'nome da loja não resolveu');
  ok(c.brinde && c.brinde.includes('Panettone'), 'descrição do brinde ausente');
});

// ---------------------------------------------------------------- execução
(async () => {
  await store.init(CAMPANHA);
  console.log('\n  Compre e Ganhe — Natal 2026\n');
  for (const c of casos) {
    try {
      await c.fn();
      console.log(`  ok    ${c.nome}`);
      passou += 1;
    } catch (e) {
      console.log(`  FALHA ${c.nome}\n          ${e.message}`);
      falhou += 1;
    }
  }
  console.log(`\n  ${passou} passaram, ${falhou} falharam\n`);
  await store.pool.end();
  process.exit(falhou ? 1 : 0);
})().catch(e => { console.error('Erro fatal:', e); process.exit(1); });
