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
    horario: 'de segunda a domingo, das 12h às 19h',
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
   * Operações participantes — relação oficial "LOJAS PARTICIPANTES NATAL LUZ"
   * (planilha do Marketing, 10/11/2026). Participam TODAS as operações do
   * shopping: varejo, alimentação, gastronomia e serviços (Cláusula 5).
   *
   * A lista é obrigatória mesmo valendo "qualquer loja": sem ela, uma nota de
   * qualquer comércio da cidade passaria.
   *
   * Vários CNPJs se repetem porque uma mesma empresa opera mais de uma marca
   * no shopping (Spoleto/Koni/Asa Açaí, HNT/Mex Burritos). Isso é esperado.
   *
   * Atenção: o CNPJ que vale é o IMPRESSO NO CUPOM, nem sempre o do cadastro.
   * Por isso os CNPJs antigos de Óticas Diniz, Boticário, Mahai e Óticas Maya
   * continuam aceitos: são as mesmas lojas, e recusar um cliente de operação
   * participante custa mais caro do que aceitar uma filial a mais.
   */
  lojasParticipantesCNPJ: [
    // --- relação oficial do Natal Luz ---
    '47361452000324', // AD LIFE — moda masculina — B/1
    '59273034000100', // ASA AÇAÍ · KONI · SPOLETO — alimentação — B/2
    '62506724000169', // CACAU SHOW — alimentação — B/2
    '36526209000130', // CENTRO DE METABOLISMO DR. IGOR MARQUES — clínica — A/2
    '57902761000156', // DERMAVIVA — clínica — A/2
    '59302709000194', // GIRAFFAS — alimentação — B/2
    '59272743000163', // HNT · MEX BURRITOS — alimentação — B/2
    '14979684000120', // INBRAND STORE — moda feminina — B/1
    '34084985000526', // MAHAI — alimentação — A/1
    '62098606000169', // NATURA — perfumaria — B/1
    '57137821000191', // PITICO KIDS — brinquedo — B/1
    '14979684001100', // SIX CLUB — moda feminina — B/1
    '13305908000155', // SMART FIT — academia — C/1
    '34230660000261', // VIA MIA — calçados — B/1
    '03756360000106', // O BOTICÁRIO — perfumaria — B/1
    '15743430000251', // OFTALMOPLUS — clínica — C/2
    '59041432000193', // ÓTICAS DINIZ — ótica — C/1
    '46727672000285', // ÓTICAS MAYA — ótica — D/1

    // --- CNPJs antigos das mesmas lojas, mantidos por segurança ---
    '26217704000104', // ÓTICAS DINIZ — CNPJ confirmado emitindo na campanha anterior
    '03756360000199', // O BOTICÁRIO — CNPJ de cadastro (cupom sai no .../0001-06)
    '34084985000100', // MAHAI — CNPJ da relação de julho
    '46727672000102', // ÓTICAS MAYA — CNPJ da relação de julho

    // HAVE FUN está na relação oficial, mas a planilha informa "NÃO EMITE NOTA".
    // Sem documento fiscal não há como cadastrar a compra, então não há CNPJ a
    // incluir aqui. Pendente de definição com a coordenação.
  ],

  /**
   * Nomes das operações, para a página pública e para o diagnóstico de recusa.
   * Chave = CNPJ só com dígitos. Onde uma empresa opera várias marcas, o nome
   * traz todas, que é como o cliente reconhece.
   */
  lojasNomes: {
    '47361452000324': { nome: 'AD Life', razao: 'Moda masculina · Bloco B, 1º piso' },
    '59273034000100': { nome: 'Spoleto · Koni · Asa Açaí', razao: 'Alimentação · Bloco B, 2º piso' },
    '62506724000169': { nome: 'Cacau Show', razao: 'Alimentação · Bloco B, 2º piso' },
    '36526209000130': { nome: 'Centro de Metabolismo Dr. Igor Marques', razao: 'Clínica médica · Bloco A, 2º piso' },
    '57902761000156': { nome: 'Dermaviva', razao: 'Clínica médica · Bloco A, 2º piso' },
    '59302709000194': { nome: 'Giraffas', razao: 'Alimentação · Bloco B, 2º piso' },
    '59272743000163': { nome: 'HNT · Mex Burritos', razao: 'Alimentação · Bloco B, 2º piso' },
    '14979684000120': { nome: 'Inbrand Store', razao: 'Moda feminina · Bloco B, 1º piso' },
    '34084985000526': { nome: 'Mahai', razao: 'Alimentação · Bloco A, 1º piso' },
    '34084985000100': { nome: 'Mahai', razao: 'Alimentação · Bloco A, 1º piso' },
    '62098606000169': { nome: 'Natura', razao: 'Perfumaria · Bloco B, 1º piso' },
    '57137821000191': { nome: 'Pitico Kids', razao: 'Brinquedos · Bloco B, 1º piso' },
    '14979684001100': { nome: 'Six Club', razao: 'Moda feminina · Bloco B, 1º piso' },
    '13305908000155': { nome: 'Smart Fit', razao: 'Academia · Bloco C, 1º piso' },
    '34230660000261': { nome: 'Via Mia', razao: 'Calçados · Bloco B, 1º piso' },
    '03756360000106': { nome: 'O Boticário', razao: 'Perfumaria · Bloco B, 1º piso' },
    '03756360000199': { nome: 'O Boticário', razao: 'Perfumaria · Bloco B, 1º piso' },
    '15743430000251': { nome: 'Oftalmoplus', razao: 'Clínica médica · Bloco C, 2º piso' },
    '59041432000193': { nome: 'Óticas Diniz', razao: 'Ótica · Bloco C, 1º piso' },
    '26217704000104': { nome: 'Óticas Diniz', razao: 'Ótica · Bloco C, 1º piso' },
    '46727672000285': { nome: 'Óticas Maya', razao: 'Ótica · Bloco D, 1º piso' },
    '46727672000102': { nome: 'Óticas Maya', razao: 'Ótica · Bloco D, 1º piso' },
  },

  status: 'ATIVA',
};
