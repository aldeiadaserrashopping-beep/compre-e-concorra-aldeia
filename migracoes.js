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
  // Atendente do balcão de retirada (Natal 2026).
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
};
