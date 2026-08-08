'use strict';
/**
 * Correções pontuais aplicadas no boot. Todas IDEMPOTENTES: rodam uma vez,
 * fazem efeito, e nas subidas seguintes viram no-op. Cada ação fica na trilha
 * de auditoria. Não podem derrubar o boot: erro aqui é logado e o sistema sobe.
 */
const svc = require('./service');

module.exports = async function migracoes(store) {
  // ---- 1) Lojas incluídas durante a campanha (28/07) ----
  const novas = [
    { cnpj: '59041432000193', nome: 'ÓTICAS DINIZ', razao: 'Óticas Diniz (segundo CNPJ)' },
    { cnpj: '03756360000199', nome: 'O BOTICÁRIO', razao: 'Flor de Baunilha Perfumaria e Cosméticos Ltda' },
    // Filial que emite as notas no shopping (CNPJ impresso no cupom, 08/08).
    { cnpj: '03756360000106', nome: 'O BOTICÁRIO', razao: 'Flor de Baunilha Perfumaria e Cosméticos Ltda (filial)' },
  ];
  for (const l of novas) {
    await store.q(
      "INSERT INTO loja_participante (campanha_id,cnpj,nome,razao_social) VALUES ('CAMP-ALDEIA-2026',$1,$2,$3) ON CONFLICT DO NOTHING",
      [l.cnpj, l.nome, l.razao]);
    // Se já existia sem nome (inserida antes), completa o cadastro.
    await store.q(
      'UPDATE loja_participante SET nome = COALESCE(nome,$2), razao_social = COALESCE(razao_social,$3) WHERE cnpj = $1',
      [l.cnpj, l.nome, l.razao]);
  }

  // ---- 2) Nota da Mariana Lima: valor digitado errado (R$ 1,28 em vez de R$ 1.278,00) ----
  // A moderação rejeitou pelo valor divergente e a trava de nota única (correta)
  // impediu o reenvio. Correção: ajustar o valor na nota ORIGINAL, registrar na
  // auditoria e aprovar. Só se aplica enquanto existir exatamente essa nota
  // rejeitada com o valor errado — depois de aprovada, nunca mais roda.
  const r = await store.q(
    `SELECT n.id FROM nota_fiscal n JOIN participante p ON p.id = n.participante_id
     WHERE n.status IN ('REJEITADA','CANCELADA')
       AND n.valor_total_cents < 1000
       AND n.cnpj_emitente IN ('26217704000104','59041432000193')
       AND p.nome ILIKE '%mariana%'`);
  if (r.rows.length === 1) {
    const id = r.rows[0].id;
    await store.q(
      'UPDATE nota_fiscal SET valor_total_cents = $1, valor_elegivel_cents = $1 WHERE id = $2',
      [127800, id]);
    await store.auditar(null, {
      entidade: 'nota_fiscal', entidadeId: id, acao: 'CORRECAO_VALOR',
      usuario: 'marketing@shoppingaldeiadaserra.com.br (correção de digitação)',
      valorAnterior: { valorTotalCents: 128 },
      valorNovo: { valorTotalCents: 127800, motivo: 'Participante digitou R$ 1,28; valor correto R$ 1.278,00 conforme foto da NF.' },
    });
    const out = await svc.aprovarNota(id, 'marketing@shoppingaldeiadaserra.com.br (reanálise após correção)', null);
    console.log(`MIGRACAO: nota ${id} corrigida para R$ 1.278,00 e aprovada — números emitidos: ${out.emitidos.length}`);
  }
};
