'use strict';
/**
 * Serviços de domínio: cadastro, notas, geração/inutilização de números, sorteio.
 * Orquestra core.js (regras puras) + store-pg.js (persistência + auditoria).
 *
 * Regra da casa: tudo que altera Número da Sorte acontece DENTRO de uma transação.
 * Se qualquer passo falhar, nada é gravado — nunca fica um número emitido sem a
 * nota que o originou, nem uma nota aprovada sem os números correspondentes.
 */
const crypto = require('crypto');
const core = require('./core');
const store = require('./store-pg');
const CAMPANHA = require('./campanha.config');

const VERSAO_REGULAMENTO = 'v1.0';
const VERSAO_PRIVACIDADE = 'v1.0';
const LIMITE_FOTO_BYTES = 6 * 1024 * 1024; // 6 MB por foto

// ---------- CADASTRO (Seção 3) ----------
async function cadastrarParticipante(dados, ip, userAgent) {
  const cpf = String(dados.cpf || '').replace(/\D/g, '');
  if (!core.cpfValido(cpf)) throw err('E-CAD-03', 'CPF inválido.');
  if (!core.maiorDeIdade(dados.dataNascimento)) throw err('E-CAD-02', 'É necessário ter 18 anos ou mais.');
  if (!dados.nome || String(dados.nome).trim().length < 6)
    throw err('E-CAD-06', 'Informe o nome completo (mínimo 6 caracteres).');
  if (!dados.aceiteRegulamento || !dados.aceitePrivacidade)
    throw err('E-CAD-05', 'É obrigatório aceitar o regulamento e a política de privacidade.');

  const cpfHash = core.cpfHash(cpf);

  return store.tx(async (cli) => {
    const campanha = await store.getCampanha(cli, CAMPANHA.id);
    if (campanha.denylistCPFHash.includes(cpfHash)) throw err('E-CAD-04', 'CPF impedido de participar.');
    if (await store.getParticipantePorCpfHash(cli, cpfHash)) throw err('E-CAD-01', 'Este CPF já possui cadastro.');

    const id = await store.criarParticipante(cli, {
      cpf, cpfHash, nome: String(dados.nome).trim(), dataNascimento: dados.dataNascimento,
      telefone: dados.telefone, email: dados.email, cidade: dados.cidade, uf: dados.uf,
    });

    // Prova de consentimento (LGPD): tipo, versão, IP e dispositivo, um registro por finalidade.
    // Marketing é registrado separado porque é opcional — não pode ser condição para participar.
    for (const c of [
      { tipo: 'regulamento', versao: VERSAO_REGULAMENTO, aceito: true },
      { tipo: 'privacidade', versao: VERSAO_PRIVACIDADE, aceito: true },
      { tipo: 'marketing', versao: VERSAO_PRIVACIDADE, aceito: !!dados.aceiteMarketing },
    ]) await store.registrarConsentimento(cli, id, { ...c, ip, userAgent });

    await store.auditar(cli, {
      entidade: 'participante', entidadeId: id, acao: 'CADASTRO', ip, userAgent,
      valorNovo: { cpfHash, marketing: !!dados.aceiteMarketing },
    });

    const p = await store.getParticipante(cli, id);
    return publicoParticipante(p);
  });
}

// ---------- NOTAS (Seções 4 e 5) ----------
async function enviarNota(participanteId, nota, ip, userAgent) {
  // FOTO OBRIGATÓRIA como evidência (Seção 4/15) — método principal QR + evidência visual
  if (!nota.fotoBase64) throw err('E-NOTA-13', 'É obrigatório anexar uma foto da nota fiscal.');
  const foto = decodificarFoto(nota.fotoBase64);

  return store.tx(async (cli) => {
    const p = await store.getParticipante(cli, participanteId);
    if (!p) throw err('E-AUTH-03', 'Participante não encontrado.');
    const campanha = await store.getCampanha(cli, CAMPANHA.id);

    // 1) Método principal: chave/QR da NFC-e (estruturado) ---------------------
    let chave = (nota.chaveNfe || '').replace(/\D/g, '');
    if (nota.qrTexto && !chave) {
      const extraida = core.extrairChaveDeQR(nota.qrTexto);
      if (extraida) chave = extraida;
    }
    let cnpj = (nota.cnpjEmitente || '').replace(/\D/g, '');
    let anoMesNota = null;
    if (chave) {
      const parsed = core.parseChaveNFe(chave);
      if (!parsed.valida) throw err('E-NOTA-07', `Chave/QR inválido: ${parsed.erro}`);
      cnpj = parsed.cnpjEmitente;          // CNPJ vem da chave (fonte confiável)
      anoMesNota = parsed.anoMes;          // AAAA-MM da emissão
      chave = parsed.chave;
    }

    // Deduplicação (RN-05). O UNIQUE em chave_nfe é a barreira final: se duas
    // requisições simultâneas passarem por esta checagem, o banco derruba a segunda.
    if (chave && await store.getNotaPorChave(cli, chave))
      throw err('E-NOTA-01', 'Esta nota já foi cadastrada.');
    // CPF da nota == participante (RN-06) — só se informado (QR nem sempre traz CPF)
    if (nota.cpfNota && String(nota.cpfNota).replace(/\D/g, '') !== p.cpf)
      throw err('E-NOTA-02', 'A nota deve estar no seu CPF.');
    // Loja participante (lista de CNPJs)
    if (campanha.lojasParticipantesCNPJ.length && cnpj &&
        !campanha.lojasParticipantesCNPJ.includes(cnpj))
      throw err('E-NOTA-04', 'Loja não participante.');
    // Data no período (RN-09): usa data informada (dia) ou o mês da chave
    const inicioMes = campanha.dataInicio.slice(0, 7);
    const fimMes = campanha.dataFim.slice(0, 7);
    if (nota.dataCompra) {
      if (nota.dataCompra < campanha.dataInicio || nota.dataCompra > campanha.dataFim)
        throw err('E-NOTA-03', 'Data da compra fora do período da campanha.');
    } else if (anoMesNota && (anoMesNota < inicioMes || anoMesNota > fimMes)) {
      throw err('E-NOTA-03', 'Mês da nota fora do período da campanha.');
    }

    const valorTotalCents = core.toCents(nota.valorTotal);
    if (!(valorTotalCents > 0)) throw err('E-NOTA-08', 'Informe o valor total da nota.');
    const itens = (nota.itens || []).map(i => ({ ...i, valorCents: core.toCents(i.valor) }));
    const valorElegivelCents = core.valorElegivelNota(valorTotalCents, itens);

    const notaId = await store.criarNota(cli, {
      campanhaId: campanha.id, participanteId,
      chaveNfe: chave || null, cnpjEmitente: cnpj || null,
      valorTotalCents, valorElegivelCents,
      dataCompra: nota.dataCompra || null, anoMesNota,
      origem: chave ? (nota.qrTexto ? 'QR' : 'CHAVE') : 'FOTO',
      fotoUrl: null,
    });
    const sha = await store.salvarFoto(cli, notaId, foto);
    await store.auditar(cli, {
      entidade: 'nota_fiscal', entidadeId: notaId, acao: 'ENVIO', ip, userAgent,
      valorNovo: { status: 'EM_ANALISE', origem: chave ? 'QR/CHAVE' : 'FOTO', valorElegivelCents, fotoSha256: sha },
    });
    return await store.getNota(cli, notaId);
  });
}

// Aceita apenas dataURL de imagem; devolve buffer + mime já validados.
function decodificarFoto(fotoBase64) {
  const m = /^data:(image\/(png|jpe?g|webp));base64,(.+)$/i.exec(String(fotoBase64));
  if (!m) throw err('E-UP-01', 'Formato de imagem inválido (use JPG/PNG/WEBP).');
  const buffer = Buffer.from(m[3], 'base64');
  if (!buffer.length) throw err('E-UP-01', 'Imagem vazia.');
  if (buffer.length > LIMITE_FOTO_BYTES)
    throw err('E-UP-02', 'A foto excede 6 MB. Tire a foto novamente com menos zoom.');
  return { mime: m[1].toLowerCase().replace('image/jpeg', 'image/jpeg'), buffer };
}

// ---------- MODERAÇÃO (Seção 4.4) ----------
const mudarStatusNota = (novoStatus, acao) => async (notaId, motivo, usuario, ip) =>
  store.tx(async (cli) => {
    const nota = await store.getNota(cli, notaId);
    if (!nota) throw err('E-NOTA-404', 'Nota não encontrada.');
    if (nota.status === novoStatus) throw err('E-NOTA-09', `A nota já está ${novoStatus}.`);
    await store.atualizarStatusNota(cli, notaId, { status: novoStatus, motivoRejeicao: motivo || null, analisadoPor: usuario });
    await store.auditar(cli, {
      entidade: 'nota_fiscal', entidadeId: notaId, acao, usuario, ip,
      valorAnterior: { status: nota.status }, valorNovo: { status: novoStatus, motivo: motivo || null },
    });
    // Recalcula na MESMA transação: nota e números nunca ficam fora de sincronia.
    return recalcularNumeros(cli, nota.participanteId, usuario, ip, `${acao} da nota ${notaId}`);
  });

const aprovarNota = (notaId, usuario, ip) => mudarStatusNota('APROVADA', 'APROVACAO')(notaId, null, usuario, ip);
const rejeitarNota = mudarStatusNota('REJEITADA', 'REJEICAO');
const cancelarNota = mudarStatusNota('CANCELADA', 'CANCELAMENTO');

// ---------- Núcleo do recálculo (Seção 6.7) ----------
// Emite novos números ou inutiliza excedentes. Sempre chamado dentro de uma transação.
async function recalcularNumeros(cli, participanteId, usuario, ip, motivo) {
  const p = await store.getParticipante(cli, participanteId);
  const aprovadas = await store.notasDoParticipante(cli, participanteId, 'APROVADA');
  const V = aprovadas.reduce((s, n) => s + n.valorElegivelCents, 0);
  const { numerosDevidos, saldoRemanescenteCents } = core.calcularNumeros(V);

  const ativos = await store.numerosDoParticipante(cli, participanteId, 'ATIVO');
  let emitidos = [], inutilizados = [];

  if (numerosDevidos > ativos.length) {
    emitidos = await store.emitirNumeros(cli, {
      campanhaId: CAMPANHA.id, participanteId, cpfHash: p.cpfHash,
      notaOrigemId: aprovadas.length ? aprovadas[aprovadas.length - 1].id : null,
      quantidade: numerosDevidos - ativos.length,
    });
  } else if (numerosDevidos < ativos.length) {
    // Inutiliza os mais recentes primeiro (Seção 6.8): números nunca são apagados.
    inutilizados = await store.inutilizarNumeros(cli, {
      participanteId, quantidade: ativos.length - numerosDevidos, motivo, usuario, ip,
    });
  }

  await store.atualizarTotais(cli, participanteId, {
    valorElegivelCents: V,
    saldoRemanescenteCents,
    numerosAtivos: numerosDevidos,
  });
  await store.auditar(cli, {
    entidade: 'numero_sorte', entidadeId: participanteId, acao: 'RECALCULO', usuario, ip,
    valorNovo: { motivo, valorElegivelCents: V, numerosDevidos, emitidos: emitidos.length, inutilizados: inutilizados.length },
  });

  const atualizado = await store.getParticipante(cli, participanteId);
  return { participante: publicoParticipante(atualizado), emitidos, inutilizados, numerosDevidos };
}

// ---------- SORTEIO (Seção 7) ----------
async function apurar(premiosLoteria, usuario, ip) {
  return store.tx(async (cli) => {
    const campanha = await store.getCampanha(cli, CAMPANHA.id, true); // trava: nenhum número novo durante a apuração
    const ativos = await store.numerosAtivos(cli);
    if (!ativos.length) throw err('E-SORT-02', 'Não há Números da Sorte ativos para apurar.');

    // Snapshot: o hash de todos os números ativos no instante da apuração. Prova
    // depois que a base não foi alterada entre o sorteio e a prestação de contas.
    const snapshotHash = crypto.createHash('sha256')
      .update(ativos.map(n => n.hashIntegridade).join('')).digest('hex');

    const sorteioId = await store.criarSorteio(cli, {
      campanhaId: campanha.id, resultadoLoteria: premiosLoteria, snapshotHash, executadoPor: usuario,
    });

    const excluir = [];
    const ganhadores = [];
    let ultimoNumero = null; // número contemplado no prêmio anterior
    for (let premio = 1; premio <= campanha.qtdGanhadores; premio++) {
      // 1º prêmio: composição da Loteria Federal (cláusula 9.2).
      // Demais prêmios: PRÓXIMO NÚMERO VÁLIDO imediatamente superior ao anterior (cláusula 9.4).
      const numeroAlvo = premio === 1
        ? core.numeroContempladoPadrao(premiosLoteria)
        : String((parseInt(ultimoNumero, 10) + 1) % 100000).padStart(5, '0');
      const { ganhador, regra } = core.localizarGanhador(numeroAlvo, ativos, '01', excluir);
      let g;
      if (ganhador) {
        ultimoNumero = ganhador.numero;
        // Cláusula 9.4: ganhadores devem ser participantes distintos — exclui todos os
        // números do contemplado antes de buscar o prêmio seguinte.
        ativos.filter(n => n.participanteId === ganhador.participanteId).forEach(n => excluir.push(n.id));
        const part = await store.getParticipante(cli, ganhador.participanteId);
        g = { premioOrdem: premio, numeroAlvo, regra, numeroId: ganhador.id,
              numero: `${ganhador.serie}-${ganhador.numero}`, participanteId: ganhador.participanteId,
              nome: part ? part.nome : null, cpf: part ? mascararCpf(part.cpf) : null,
              tipo: 'TITULAR', status: 'CONTEMPLADO' };
      } else {
        g = { premioOrdem: premio, numeroAlvo, regra: 'NENHUM', status: 'SEM_GANHADOR' };
      }
      await store.criarGanhador(cli, sorteioId, g);
      ganhadores.push(g);
    }

    await store.auditar(cli, {
      entidade: 'sorteio', entidadeId: sorteioId, acao: 'APURACAO', usuario, ip,
      valorNovo: { snapshotHash, resultadoLoteria: premiosLoteria, ganhadores },
    });
    return { id: sorteioId, campanhaId: campanha.id, dataApuracao: new Date().toISOString(),
             resultadoLoteria: premiosLoteria, snapshotHash, totalNumerosAtivos: ativos.length, ganhadores };
  });
}

// ---------- helpers ----------
function publicoParticipante(p) {
  return {
    id: p.id, nome: p.nome, cpf: mascararCpf(p.cpf), cidade: p.cidade, uf: p.uf,
    valorElegivel: core.fromCents(p.valorElegivelCents),
    saldoRemanescente: core.fromCents(p.saldoRemanescenteCents),
    numerosAtivos: p.numerosAtivos,
  };
}
function mascararCpf(cpf) { return String(cpf).replace(/^(\d{3})\d{6}(\d{2})$/, '$1.***.***-$2'); }
function err(codigo, mensagem) { const e = new Error(mensagem); e.codigo = codigo; e.publico = true; return e; }

module.exports = {
  cadastrarParticipante, enviarNota, aprovarNota, rejeitarNota, cancelarNota,
  recalcularNumeros, apurar, publicoParticipante, mascararCpf, CAMPANHA,
};
