'use strict';
/**
 * NÚCLEO DE REGRAS DE NEGÓCIO — Campanha "Compre e Concorra" Shopping Aldeia da Serra
 * Funções puras (sem I/O) para máxima auditabilidade e testabilidade.
 * Referência: Especificação Funcional, Seções 5, 6 e 7.
 */
const crypto = require('crypto');

const UNIDADE = 400.0; // R$ 400,00 => 1 Número da Sorte (RN-01)

// ---------- Utilidades monetárias (trabalha em centavos p/ evitar erro de ponto flutuante) ----------
const toCents = (v) => Math.round(Number(v) * 100);
const fromCents = (c) => c / 100;
const UNIDADE_CENTS = toCents(UNIDADE); // 40000

// ---------- Validação de CPF (dígitos verificadores) ----------
function cpfValido(cpf) {
  cpf = String(cpf).replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (base, pesoIni) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += parseInt(base[i], 10) * (pesoIni - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = calc(cpf.slice(0, 9), 10);
  const d2 = calc(cpf.slice(0, 10), 11);
  return d1 === parseInt(cpf[9], 10) && d2 === parseInt(cpf[10], 10);
}

function maiorDeIdade(dataNascISO, hoje = new Date()) {
  const n = new Date(dataNascISO);
  if (isNaN(n)) return false;
  let idade = hoje.getFullYear() - n.getFullYear();
  const m = hoje.getMonth() - n.getMonth();
  if (m < 0 || (m === 0 && hoje.getDate() < n.getDate())) idade--;
  return idade >= 18;
}

// ---------- Cálculo de números da sorte (Seção 6.1) ----------
// valorElegivelTotalCents -> quantidade de números devidos (piso) e saldo remanescente
function calcularNumeros(valorElegivelTotalCents) {
  const n = Math.floor(valorElegivelTotalCents / UNIDADE_CENTS);
  const remanescenteCents = valorElegivelTotalCents - n * UNIDADE_CENTS;
  return { numerosDevidos: n, saldoRemanescenteCents: remanescenteCents };
}

// ---------- Valor elegível de uma nota (Seção 5.2) ----------
// itens: [{descricao, valorCents, vedado:bool}]  (se não houver itens, usa valorTotalCents)
function valorElegivelNota(valorTotalCents, itens) {
  if (!Array.isArray(itens) || itens.length === 0) return valorTotalCents;
  const vedado = itens.filter(i => i.vedado).reduce((s, i) => s + i.valorCents, 0);
  return Math.max(0, valorTotalCents - vedado);
}

// ---------- Hash encadeado (ledger) para integridade dos números (Seção 6.6) ----------
function hashNumero(hashAnterior, campanhaId, serie, numero, cpfHash, notaId, emitidoEm) {
  return crypto.createHash('sha256')
    .update(`${hashAnterior}|${campanhaId}|${serie}|${numero}|${cpfHash}|${notaId}|${emitidoEm}`)
    .digest('hex');
}

function cpfHash(cpf) {
  return crypto.createHash('sha256').update(String(cpf).replace(/\D/g, '')).digest('hex');
}

/**
 * Aloca próximos números da sorte de forma única e sequencial dentro de uma série.
 * seriesConfig: { serieAtual, proximoNumero, tamanhoSerie(=100000), digitos(=5) }
 * Retorna { numeros:[{serie,numero}], seriesConfig atualizado }  (Seção 6.2/6.3)
 */
function alocarNumeros(quantidade, seriesConfig) {
  const cfg = { ...seriesConfig };
  const numeros = [];
  for (let i = 0; i < quantidade; i++) {
    if (cfg.proximoNumero >= cfg.tamanhoSerie) { // estouro de série -> nova série (Seção 13.1)
      cfg.serieAtual += 1;
      cfg.proximoNumero = 0;
    }
    numeros.push({
      serie: String(cfg.serieAtual).padStart(2, '0'),
      numero: String(cfg.proximoNumero).padStart(cfg.digitos, '0'),
    });
    cfg.proximoNumero += 1;
  }
  return { numeros, seriesConfig: cfg };
}

// ---------- Apuração vinculada à Loteria Federal (Seção 7) ----------
// Composição padrão (CONFIGURÁVEL / A VALIDAR NO REGULAMENTO): concatena o último dígito
// de cada um dos 5 prêmios da Loteria Federal para formar um número de 5 dígitos.
function numeroContempladoPadrao(premiosLoteria) {
  // premiosLoteria: array de 5 strings/numeros (1º ao 5º prêmio)
  const dig = premiosLoteria.slice(0, 5).map(p => String(p).replace(/\D/g, '').slice(-1));
  return dig.join('').padStart(5, '0');
}

/**
 * Localiza ganhador pelo número apurado, com regra de aproximação (Seção 7.2):
 * exato -> imediatamente superior -> imediatamente inferior (circular dentro da série).
 * numerosAtivos: [{serie, numero, participanteId}] já filtrados por ATIVO
 */
function localizarGanhador(numeroAlvo, numerosAtivos, serie, excluirIds = []) {
  const disp = numerosAtivos.filter(n => n.serie === serie && !excluirIds.includes(n.id));
  const alvo = parseInt(numeroAlvo, 10);
  const mapa = new Map(disp.map(n => [parseInt(n.numero, 10), n]));
  if (mapa.has(alvo)) return { ganhador: mapa.get(alvo), regra: 'EXATO' };
  const max = 100000;
  for (let d = 1; d < max; d++) {
    const sup = (alvo + d) % max;
    if (mapa.has(sup)) return { ganhador: mapa.get(sup), regra: `APROXIMACAO_SUPERIOR(+${d})` };
    const inf = (alvo - d + max) % max;
    if (mapa.has(inf)) return { ganhador: mapa.get(inf), regra: `APROXIMACAO_INFERIOR(-${d})` };
  }
  return { ganhador: null, regra: 'NENHUM' };
}

// ---------- Chave de acesso NF-e / NFC-e (44 dígitos) — Seção 4.1/5.1 ----------
// Estrutura: cUF(2) AAMM(4) CNPJ(14) mod(2) serie(3) nNF(9) tpEmis(1) cNF(8) cDV(1)
function validarDVChave(chave43) {
  // Dígito verificador módulo 11 (pesos 2..9 cíclicos, da direita p/ esquerda)
  let peso = 2, soma = 0;
  for (let i = chave43.length - 1; i >= 0; i--) {
    soma += parseInt(chave43[i], 10) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  const dv = (resto === 0 || resto === 1) ? 0 : 11 - resto;
  return dv;
}

function parseChaveNFe(chaveRaw) {
  const chave = String(chaveRaw || '').replace(/\D/g, '');
  if (chave.length !== 44) return { valida: false, erro: 'Chave deve ter 44 dígitos.' };
  const dvCalc = validarDVChave(chave.slice(0, 43));
  const dvInformado = parseInt(chave[43], 10);
  if (dvCalc !== dvInformado) return { valida: false, erro: 'Dígito verificador inválido (possível erro de digitação/adulteração).' };
  const cUF = chave.slice(0, 2);
  const aa = chave.slice(2, 4), mm = chave.slice(4, 6);
  const cnpj = chave.slice(6, 20);
  const modelo = chave.slice(20, 22); // 55=NF-e, 65=NFC-e
  const serie = chave.slice(22, 25);
  const numero = chave.slice(25, 34);
  return {
    valida: true, chave, cUF, cnpjEmitente: cnpj, modelo, serie, numero,
    anoMes: `20${aa}-${mm}`, // granularidade mês (dia vem da foto/consulta SEFAZ)
    ufSigla: UF_POR_CODIGO[cUF] || null,
  };
}

// Extrai a chave de 44 dígitos de dentro da URL contida no QR Code da NFC-e
function extrairChaveDeQR(textoQR) {
  const s = String(textoQR || '');
  // tenta parâmetros comuns (p= / chNFe=) e, por fim, qualquer sequência de 44 dígitos
  const m = s.match(/(?:chNFe=|p=)?(\d{44})/);
  return m ? m[1] : null;
}

const UF_POR_CODIGO = {
  '11':'RO','12':'AC','13':'AM','14':'RR','15':'PA','16':'AP','17':'TO','21':'MA','22':'PI','23':'CE',
  '24':'RN','25':'PB','26':'PE','27':'AL','28':'SE','29':'BA','31':'MG','32':'ES','33':'RJ','35':'SP',
  '41':'PR','42':'SC','43':'RS','50':'MS','51':'MT','52':'GO','53':'DF',
};

module.exports = {
  UNIDADE, UNIDADE_CENTS, toCents, fromCents,
  cpfValido, maiorDeIdade, calcularNumeros, valorElegivelNota,
  hashNumero, cpfHash, alocarNumeros, numeroContempladoPadrao, localizarGanhador,
  parseChaveNFe, extrairChaveDeQR, validarDVChave,
};
