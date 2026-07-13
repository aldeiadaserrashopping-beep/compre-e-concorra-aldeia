'use strict';
/**
 * Serviços de domínio: cadastro, notas, geração/inutilização de números, sorteio.
 * Orquestra core.js (regras puras) + db.js (persistência + auditoria).
 */
const core = require('./core');
const db = require('./db');

// ---------- CADASTRO (Seção 3) ----------
function cadastrarParticipante(dados, ip) {
  const store = db.load();
  const cpf = String(dados.cpf || '').replace(/\D/g, '');
  if (!core.cpfValido(cpf)) throw err('E-CAD-03', 'CPF inválido.');
  if (!core.maiorDeIdade(dados.dataNascimento)) throw err('E-CAD-02', 'É necessário ter 18 anos ou mais.');
  if (store.campanha.denylistCPF.includes(cpf)) throw err('E-CAD-04', 'CPF impedido de participar.');
  if (store.participantes.some(p => p.cpf === cpf)) throw err('E-CAD-01', 'Este CPF já possui cadastro.');
  if (!dados.aceiteRegulamento || !dados.aceitePrivacidade)
    throw err('E-CAD-05', 'É obrigatório aceitar o regulamento e a política de privacidade.');

  const p = {
    id: db.nextId('P'),
    cpf, cpfHash: core.cpfHash(cpf),
    nome: dados.nome, dataNascimento: dados.dataNascimento,
    telefone: dados.telefone, email: dados.email,
    cidade: dados.cidade, uf: dados.uf,
    valorElegivelCents: 0, saldoRemanescenteCents: 0, numerosAtivos: 0,
    consentimentos: [
      consent('regulamento', 'v1.0', true, ip, dados.dispositivo),
      consent('privacidade', 'v1.0', true, ip, dados.dispositivo),
      consent('marketing', 'v1.0', !!dados.aceiteMarketing, ip, dados.dispositivo),
    ],
    criadoEm: new Date().toISOString(),
  };
  store.participantes.push(p);
  db.save();
  db.auditar({ entidade: 'participante', entidadeId: p.id, acao: 'CADASTRO', ip, valorNovo: { cpfHash: p.cpfHash } });
  return publicoParticipante(p);
}

function consent(tipo, versao, aceito, ip, dispositivo) {
  return { tipo, versao, aceito, ip, dispositivo: dispositivo || null, dataHora: new Date().toISOString() };
}

// ---------- NOTAS (Seções 4 e 5) ----------
function enviarNota(participanteId, nota, ip) {
  const store = db.load();
  const p = store.participantes.find(x => x.id === participanteId);
  if (!p) throw err('E-AUTH-03', 'Participante não encontrado.');

  // FOTO OBRIGATÓRIA como evidência (Seção 4/15) — método principal QR + evidência visual
  if (!nota.fotoBase64) throw err('E-NOTA-13', 'É obrigatório anexar uma foto da nota fiscal.');

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

  // Deduplicação (RN-05)
  if (chave && store.notas.some(n => n.chaveNfe === chave))
    throw err('E-NOTA-01', 'Esta nota já foi cadastrada.');
  // CPF da nota == participante (RN-06) — só se informado (QR nem sempre traz CPF)
  if (nota.cpfNota && String(nota.cpfNota).replace(/\D/g, '') !== p.cpf)
    throw err('E-NOTA-02', 'A nota deve estar no seu CPF.');
  // Loja participante (lista de CNPJs); se lista vazia, aceita (protótipo)
  if (store.campanha.lojasParticipantesCNPJ.length && cnpj &&
      !store.campanha.lojasParticipantesCNPJ.includes(cnpj))
    throw err('E-NOTA-04', 'Loja não participante.');
  // Data no período (RN-09): usa data informada (dia) ou o mês da chave
  const inicioMes = store.campanha.dataInicio.slice(0, 7);
  const fimMes = store.campanha.dataFim.slice(0, 7);
  if (nota.dataCompra) {
    if (nota.dataCompra < store.campanha.dataInicio || nota.dataCompra > store.campanha.dataFim)
      throw err('E-NOTA-03', 'Data da compra fora do período da campanha.');
  } else if (anoMesNota && (anoMesNota < inicioMes || anoMesNota > fimMes)) {
    throw err('E-NOTA-03', 'Mês da nota fora do período da campanha.');
  }

  const valorTotalCents = core.toCents(nota.valorTotal);
  const itens = (nota.itens || []).map(i => ({ ...i, valorCents: core.toCents(i.valor) }));
  const valorElegivelCents = core.valorElegivelNota(valorTotalCents, itens);

  // Persiste a foto como evidência (arquivo separado)
  const fotoUrl = salvarFoto(nota.fotoBase64);

  const registro = {
    id: db.nextId('NF'),
    participanteId, chaveNfe: chave || null,
    cnpjEmitente: cnpj || null, valorTotalCents, valorElegivelCents,
    dataCompra: nota.dataCompra || null, anoMesNota,
    origem: chave ? (nota.qrTexto ? 'QR' : 'CHAVE') : 'FOTO',
    fotoUrl,
    status: 'EM_ANALISE', // moderação (Seção 4.4)
    motivoRejeicao: null,
    criadoEm: new Date().toISOString(),
  };
  store.notas.push(registro);
  db.save();
  db.auditar({ entidade: 'nota_fiscal', entidadeId: registro.id, acao: 'ENVIO', ip, valorNovo: { status: 'EM_ANALISE', origem: registro.origem, valorElegivelCents } });
  return registro;
}

// Salva a foto (base64 dataURL) em data/uploads e retorna o caminho relativo
function salvarFoto(fotoBase64) {
  const fs = require('fs'), path = require('path');
  const dir = path.join(__dirname, 'data', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const m = /^data:(image\/(png|jpe?g|webp));base64,(.+)$/i.exec(fotoBase64);
  if (!m) throw err('E-UP-01', 'Formato de imagem inválido (use JPG/PNG/WEBP).');
  const ext = m[2].replace('jpeg', 'jpg');
  const nome = `nota_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(dir, nome), Buffer.from(m[3], 'base64'));
  return `data/uploads/${nome}`;
}

// Aprovação -> recalcula números (Seções 6.1/6.7)
function aprovarNota(notaId, usuario, ip) {
  const store = db.load();
  const nota = store.notas.find(n => n.id === notaId);
  if (!nota) throw err('E-NOTA-404', 'Nota não encontrada.');
  const antes = nota.status;
  nota.status = 'APROVADA';
  nota.analisadoPor = usuario; nota.analisadoEm = new Date().toISOString();
  db.save();
  db.auditar({ entidade: 'nota_fiscal', entidadeId: notaId, acao: 'APROVACAO', usuario, ip, valorAnterior: { status: antes }, valorNovo: { status: 'APROVADA' } });
  return recalcularNumeros(nota.participanteId, usuario, ip, `Aprovação da nota ${notaId}`);
}

function rejeitarNota(notaId, motivo, usuario, ip) {
  const store = db.load();
  const nota = store.notas.find(n => n.id === notaId);
  if (!nota) throw err('E-NOTA-404', 'Nota não encontrada.');
  const antes = nota.status;
  nota.status = 'REJEITADA'; nota.motivoRejeicao = motivo;
  nota.analisadoPor = usuario; nota.analisadoEm = new Date().toISOString();
  db.save();
  db.auditar({ entidade: 'nota_fiscal', entidadeId: notaId, acao: 'REJEICAO', usuario, ip, valorAnterior: { status: antes }, valorNovo: { status: 'REJEITADA', motivo } });
  return recalcularNumeros(nota.participanteId, usuario, ip, `Rejeição da nota ${notaId}`);
}

function cancelarNota(notaId, motivo, usuario, ip) {
  const store = db.load();
  const nota = store.notas.find(n => n.id === notaId);
  if (!nota) throw err('E-NOTA-404', 'Nota não encontrada.');
  const antes = nota.status;
  nota.status = 'CANCELADA'; nota.motivoRejeicao = motivo;
  db.save();
  db.auditar({ entidade: 'nota_fiscal', entidadeId: notaId, acao: 'CANCELAMENTO', usuario, ip, valorAnterior: { status: antes }, valorNovo: { status: 'CANCELADA', motivo } });
  return recalcularNumeros(nota.participanteId, usuario, ip, `Cancelamento da nota ${notaId}`);
}

// Núcleo do recálculo: emite novos ou inutiliza excedentes (Seção 6.7)
function recalcularNumeros(participanteId, usuario, ip, motivo) {
  const store = db.load();
  const p = store.participantes.find(x => x.id === participanteId);
  const notasAprovadas = store.notas.filter(n => n.participanteId === participanteId && n.status === 'APROVADA');
  const V = notasAprovadas.reduce((s, n) => s + n.valorElegivelCents, 0);
  const { numerosDevidos, saldoRemanescenteCents } = core.calcularNumeros(V);

  const ativos = store.numeros.filter(n => n.participanteId === participanteId && n.status === 'ATIVO');
  let emitidos = [], inutilizados = [];

  if (numerosDevidos > ativos.length) {
    // EMITIR novos (transação atômica simulada + hash encadeado + UNIQUE)
    const qtd = numerosDevidos - ativos.length;
    const { numeros, seriesConfig } = core.alocarNumeros(qtd, store.campanha.seriesConfig);
    for (const nn of numeros) {
      const dup = store.numeros.some(x => x.serie === nn.serie && x.numero === nn.numero);
      if (dup) throw err('E-SIS-01', 'Colisão de número (violação de unicidade).'); // nunca deve ocorrer
      const anterior = store.numeros.length ? store.numeros[store.numeros.length - 1].hashIntegridade : 'GENESIS';
      const emitidoEm = new Date().toISOString();
      const notaOrigem = notasAprovadas.length ? notasAprovadas[notasAprovadas.length - 1].id : null;
      const reg = {
        id: db.nextId('NUM'), campanhaId: store.campanha.id,
        serie: nn.serie, numero: nn.numero, participanteId,
        notaOrigemId: notaOrigem, status: 'ATIVO', emitidoEm,
        hashAnterior: anterior,
        hashIntegridade: core.hashNumero(anterior, store.campanha.id, nn.serie, nn.numero, p.cpfHash, notaOrigem, emitidoEm),
      };
      store.numeros.push(reg);
      store.numerosHistorico.push({ id: db.nextId('NH'), numeroId: reg.id, de: null, para: 'ATIVO', motivo, usuario: usuario || 'sistema', dataHora: emitidoEm });
      emitidos.push(reg);
    }
    store.campanha.seriesConfig = seriesConfig;
  } else if (numerosDevidos < ativos.length) {
    // INUTILIZAR excedentes, do mais recente ao mais antigo (Seção 6.8)
    const qtd = ativos.length - numerosDevidos;
    const ordenados = [...ativos].sort((a, b) => b.emitidoEm.localeCompare(a.emitidoEm));
    for (let i = 0; i < qtd; i++) {
      const alvo = ordenados[i];
      const real = store.numeros.find(x => x.id === alvo.id);
      real.status = 'INUTILIZADO';
      store.numerosHistorico.push({ id: db.nextId('NH'), numeroId: real.id, de: 'ATIVO', para: 'INUTILIZADO', motivo, usuario: usuario || 'sistema', dataHora: new Date().toISOString() });
      inutilizados.push(real);
    }
  }

  p.valorElegivelCents = V;
  p.saldoRemanescenteCents = saldoRemanescenteCents;
  p.numerosAtivos = store.numeros.filter(n => n.participanteId === participanteId && n.status === 'ATIVO').length;
  db.save();
  db.auditar({ entidade: 'numero_sorte', entidadeId: participanteId, acao: 'RECALCULO', usuario, ip,
    valorNovo: { motivo, valorElegivelCents: V, numerosDevidos, emitidos: emitidos.length, inutilizados: inutilizados.length } });
  return { participante: publicoParticipante(p), emitidos, inutilizados, numerosDevidos };
}

// ---------- SORTEIO (Seção 7) ----------
function apurar(premiosLoteria, usuario, ip) {
  const store = db.load();
  const ativos = store.numeros.filter(n => n.status === 'ATIVO');
  // snapshot / merkle-like root
  const snapshotHash = require('crypto').createHash('sha256')
    .update(ativos.map(n => n.hashIntegridade).join('')).digest('hex');
  const serie = store.campanha.seriesConfig ? String(1).padStart(2, '0') : '01';
  const sorteio = { id: db.nextId('SORT'), campanhaId: store.campanha.id, dataApuracao: new Date().toISOString(),
    resultadoLoteria: premiosLoteria, snapshotHash, executadoPor: usuario, ganhadores: [] };

  const excluir = [];
  let ultimoNumero = null; // número contemplado no prêmio anterior
  for (let premio = 1; premio <= store.campanha.qtdGanhadores; premio++) {
    // 1º prêmio: composição da Loteria Federal (cláusula 9.2).
    // Demais prêmios: PRÓXIMO NÚMERO VÁLIDO imediatamente superior ao anterior (cláusula 9.4).
    const numeroAlvo = premio === 1
      ? core.numeroContempladoPadrao(premiosLoteria)
      : String((parseInt(ultimoNumero, 10) + 1) % 100000).padStart(5, '0');
    const { ganhador, regra } = core.localizarGanhador(numeroAlvo, ativos, '01', excluir);
    let g;
    if (ganhador) {
      ultimoNumero = ganhador.numero;
      // Padrão: ganhadores de participantes distintos -> exclui todos os números desse CPF
      ativos.filter(n => n.participanteId === ganhador.participanteId).forEach(n => excluir.push(n.id));
      const part = store.participantes.find(x => x.id === ganhador.participanteId);
      g = { premioOrdem: premio, numeroAlvo, regra, numeroId: ganhador.id,
        numero: `${ganhador.serie}-${ganhador.numero}`, participanteId: ganhador.participanteId,
        nome: part ? part.nome : null, tipo: 'TITULAR', status: 'CONTEMPLADO' };
    } else {
      g = { premioOrdem: premio, numeroAlvo, regra: 'NENHUM', status: 'SEM_GANHADOR' };
    }
    sorteio.ganhadores.push(g);
    store.ganhadores.push({ id: db.nextId('G'), sorteioId: sorteio.id, ...g });
  }
  store.sorteios.push(sorteio);
  db.save();
  db.auditar({ entidade: 'sorteio', entidadeId: sorteio.id, acao: 'APURACAO', usuario, ip, valorNovo: { snapshotHash, resultadoLoteria: premiosLoteria, ganhadores: sorteio.ganhadores } });
  return sorteio;
}

function rotate(arr, k) { const a = arr.slice(); for (let i = 0; i < k; i++) a.push(a.shift()); return a; }

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
  recalcularNumeros, apurar, publicoParticipante,
};
