'use strict';
/**
 * Configuração da campanha — semeada no banco no primeiro boot.
 *
 * Depois do primeiro boot, a fonte da verdade é a tabela `campanha` no Postgres.
 * Alterar valores aqui NÃO muda uma campanha já criada (proposital: parâmetros de
 * uma promoção autorizada não podem mudar por deploy). A exceção é a relação de
 * lojas participantes, que é sincronizada a cada boot.
 */
module.exports = {
  id: 'CAMP-ALDEIA-2026',
  nome: 'Compre e Concorra — 2 Bicicletas Elétricas',
  valorUnidade: 500.0,
  qtdPremios: 2,
  qtdGanhadores: 2,
  dataInicio: '2026-07-24',
  dataFim: '2026-08-09',
  dataApuracao: '2026-08-19', // extração da Loteria Federal (quarta-feira)

  // TRAVA DE GO-LIVE (Seção 22): enquanto for null, o sistema opera em modo
  // "pré-autorização" e o portal exibe o aviso. Preencher com o número do
  // Certificado de Autorização assim que a SPA/MF emitir.
  numCertificadoSPA: process.env.CERTIFICADO_SPA || null,

  acumulaSaldo: true,
  seriesConfig: { serieAtual: 1, proximoNumero: 0, tamanhoSerie: 100000, digitos: 5 },

  // Lojas participantes (Relação Oficial — Julho/2026). Só dígitos.
  lojasParticipantesCNPJ: [
    '47361452000324', // AD LIFE — Sergios Vitoria Comercio de Calcados Ltda
    '59273034000100', // ASK SPOLETO — Ask Serra Foods Ltda
    '62506724000169', // CACAU SHOW — Aldeia Chocolates Ltda
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
  status: 'ATIVA',
};
