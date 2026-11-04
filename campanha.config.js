'use strict';
/**
 * Configuração da campanha ATIVA — semeada no banco no primeiro boot.
 *
 * Depois do primeiro boot, a fonte da verdade é a tabela `campanha` no Postgres.
 * Alterar valores aqui NÃO muda uma campanha já criada (proposital: os parâmetros
 * de uma promoção em andamento não podem mudar por deploy). A exceção é a relação
 * de lojas participantes, sincronizada a cada boot.
 *
 * Trocar o `id` cria uma campanha NOVA ao lado da anterior. A campanha das
 * bicicletas (CAMP-ALDEIA-2026) continua no banco, intacta e auditável — seus
 * números, sorteio e trilha seguem disponíveis para a prestação de contas.
 */
module.exports = {
  id: 'CAMP-NATAL-2026',
  nome: 'Natal Luz — Compre e Ganhe',

  // COMPRE_GANHE: brinde garantido a quem atingir o mínimo, enquanto houver
  // estoque. Sem sorteio, concurso ou vale-brinde — e por isso sem exigência de
  // autorização da Lei 5.768/71. A modalidade é o que decide o caminho do código.
  modalidade: 'COMPRE_GANHE',

  valorMinimoCents: 30000,          // R$ 300,00 acumulados (Cláusula 6)
  brindeDescricao: 'Panettone Trufado Mezzo Cacau Show 580 g',
  estoqueTotal: 300,                // Cláusula 2
  limitePorCpf: 1,                  // Cláusula 8 — garantido também por UNIQUE no banco

  dataInicio: '2026-12-01',
  dataFim: '2026-12-31',            // fim das compras e do cadastro de notas
  // Prazo de retirada separado do fim das compras: quem comprar nos últimos dias
  // precisa de tempo hábil para cadastrar, ser conferido e retirar. Sugerido na
  // revisão do regulamento — ajustar se a coordenação decidir encerrar em 31/12.
  dataFimRetirada: '2027-01-05',

  versaoRegulamento: 'natal-v1.0',

  // Promotora: R3L Empreendimentos Imobiliários Ltda. — CNPJ 30.455.678/0001-20
  promotora: {
    razaoSocial: 'R3L Empreendimentos Imobiliários Ltda.',
    cnpj: '30455678000120',
    endereco: 'Rua 1 A, nº 572, Sala 19A, Andar 2, Bloco C, Edifício SHP Aldeia da Serra, Civit II, Serra/ES, CEP 29168-063',
  },

  retirada: {
    local: 'Shopping Aldeia da Serra, Bloco B, 1º piso, ao lado do guichê da Estapar',
    horario: 'das 12h às 19h',
  },

  // --- campos herdados do modelo de sorteio (não usados no compre e ganhe) ---
  valorUnidade: 300.0,
  qtdPremios: 0,
  qtdGanhadores: 0,
  dataApuracao: null,
  numCertificadoSPA: null,          // compre e ganhe não depende de certificado
  acumulaSaldo: false,              // Cláusula 8: acima de R$ 300 não gera brinde extra
  seriesConfig: { serieAtual: 1, proximoNumero: 0, tamanhoSerie: 100000, digitos: 5 },

  /**
   * Operações participantes — SOMENTE VAREJO (Cláusula 5).
   * Ficam de fora alimentação, gastronomia e serviços.
   *
   * Atenção: o CNPJ que importa é o IMPRESSO NO CUPOM, que nem sempre é o do
   * cadastro da loja. Foi o caso do Boticário na campanha anterior (cadastro
   * .../0001-99, cupom .../0001-06). Confirmar com um cupom de exemplo de cada
   * loja antes de 1º/12.
   */
  lojasParticipantesCNPJ: [
    '47361452000324', // AD LIFE — Sergios Vitoria Comercio de Calcados Ltda
    '62506724000169', // CACAU SHOW — Aldeia Chocolates Ltda
    '14979684000120', // INBRAND STORE — Coke Luxo Comercio de Roupas Ltda
    '14979684001100', // SIX CLUB — Coke Luxo Comercio de Roupas Ltda (filial)
    '62098606000169', // NATURA ALDEIA — GM Aldeia Cosméticos Ltda
    '03756360000199', // O BOTICÁRIO — Flor de Baunilha Perfumaria e Cosméticos Ltda
    '03756360000106', // O BOTICÁRIO — filial que emite as notas no shopping
    '57137821000191', // PITICO KIDS — MC Comércio de Brinquedos Ltda
    '34230660000261', // VIA MIA — Vitoria Calçados Ltda
    '26217704000104', // ÓTICAS DINIZ — VLE Comercio de Otica Ltda
    '59041432000193', // ÓTICAS DINIZ — segundo CNPJ
    '46727672000102', // ÓTICAS MAIA — Oticas M.Maia Ltda
  ],

  /**
   * Nomes das lojas, para a página pública e para o diagnóstico de recusa.
   * Chave = CNPJ só com dígitos.
   */
  lojasNomes: {
    '47361452000324': { nome: 'AD Life', razao: 'Sergios Vitoria Comércio de Calçados Ltda' },
    '62506724000169': { nome: 'Cacau Show', razao: 'Aldeia Chocolates Ltda' },
    '14979684000120': { nome: 'Inbrand Store', razao: 'Coke Luxo Comércio de Roupas Ltda' },
    '14979684001100': { nome: 'Six Club', razao: 'Coke Luxo Comércio de Roupas Ltda (filial)' },
    '62098606000169': { nome: 'Natura Aldeia', razao: 'GM Aldeia Cosméticos Ltda' },
    '03756360000199': { nome: 'O Boticário', razao: 'Flor de Baunilha Perfumaria e Cosméticos Ltda' },
    '03756360000106': { nome: 'O Boticário', razao: 'Flor de Baunilha Perfumaria e Cosméticos Ltda (filial)' },
    '57137821000191': { nome: 'Pitico Kids', razao: 'MC Comércio de Brinquedos Ltda' },
    '34230660000261': { nome: 'Via Mia', razao: 'Vitória Calçados Ltda' },
    '26217704000104': { nome: 'Óticas Diniz', razao: 'VLE Comércio de Ótica Ltda' },
    '59041432000193': { nome: 'Óticas Diniz', razao: 'Óticas Diniz — segundo CNPJ' },
    '46727672000102': { nome: 'Óticas Maia', razao: 'Óticas M. Maia Ltda' },
  },

  status: 'ATIVA',
};
