'use strict';
/**
 * Correções pontuais aplicadas no boot. Todas IDEMPOTENTES: rodam uma vez,
 * fazem efeito, e nas subidas seguintes viram no-op. Não podem derrubar o boot:
 * erro aqui é logado e o sistema sobe.
 *
 * Histórico (campanha CAMP-ALDEIA-2026, encerrada — correções já aplicadas em
 * produção e removidas daqui para não rodar contra a campanha errada):
 *  - inclusão dos CNPJs da Óticas Diniz e do Boticário durante a campanha;
 *  - correção do valor da nota digitada como R$ 1,28 em vez de R$ 1.278,00.
 * Ambas permanecem registradas na trilha de auditoria.
 */

module.exports = async function migracoes(store) {
  // ---- 1) Atendente do balcão de retirada (Natal 2026) ----
  //
  // Criado só se BALCAO_SENHA estiver definida: sem a variável, nenhum usuário
  // de balcão existe, e a ausência é mais segura que uma senha padrão. A senha
  // é digitada pela equipe no painel do Render — nunca fica no código.
  if (process.env.BALCAO_SENHA) {
    const email = process.env.BALCAO_EMAIL || 'retirada@shoppingaldeiadaserra.com.br';
    const { rows } = await store.q('SELECT id FROM usuario WHERE lower(email) = lower($1)', [email]);
    if (!rows.length) {
      await store.q(
        `INSERT INTO usuario (id,nome,email,senha_hash,perfil,ativo) VALUES ($1,$2,$3,$4,'BALCAO',TRUE)`,
        ['U-BALCAO', 'Balcão de Retirada', email, store.hashSenha(process.env.BALCAO_SENHA)]);
      console.log('MIGRACAO: usuário do balcão criado —', email);
    }
  }

  // ---- 2) Prazo de retirada conforme o regulamento aprovado em 05/11 ----
  //
  // A campanha foi criada com retirada até 05/01/2027, que era a sugestão em
  // revisão. O regulamento aprovado manteve o encerramento em 31/12/2026
  // (Cláusulas 2 e 9). Parâmetro de campanha não muda por deploy — por isso a
  // correção vem por aqui, com registro na trilha de auditoria.
  const { rows: cam } = await store.q(
    `SELECT data_fim_retirada, versao_regulamento FROM campanha WHERE id = 'CAMP-NATAL-2026'`);
  if (cam.length && String(cam[0].data_fim_retirada) !== '2026-12-31') {
    const anterior = String(cam[0].data_fim_retirada);
    await store.q(
      `UPDATE campanha SET data_fim_retirada = '2026-12-31', versao_regulamento = 'natal-aprovado-05.11'
       WHERE id = 'CAMP-NATAL-2026'`);
    await store.auditar(null, {
      entidade: 'campanha', entidadeId: 'CAMP-NATAL-2026', acao: 'CORRECAO_PRAZO_RETIRADA',
      usuario: 'marketing@shoppingaldeiadaserra.com.br (regulamento aprovado em 05/11)',
      valorAnterior: { dataFimRetirada: anterior, versaoRegulamento: cam[0].versao_regulamento },
      valorNovo: {
        dataFimRetirada: '2026-12-31', versaoRegulamento: 'natal-aprovado-05.11',
        motivo: 'Regulamento aprovado mantém o encerramento da campanha e do resgate em 31/12/2026.',
      },
    });
    console.log(`MIGRACAO: prazo de retirada corrigido de ${anterior} para 2026-12-31`);
  }
};
