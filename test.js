'use strict';
/**
 * Testes de verificação do núcleo (Especificação, Seção 21 — Critérios de Aceitação).
 * Executa: node test.js
 */
const assert = require('assert');
const core = require('./core');

let ok = 0, fail = 0;
function t(nome, fn) { try { fn(); ok++; console.log('  ✓', nome); } catch (e) { fail++; console.log('  ✗', nome, '->', e.message); } }
const c = core.toCents;

console.log('\n== Cálculo de Números da Sorte (piso R$400) ==');
t('R$399,99 => 0 números, remanescente R$399,99', () => {
  const r = core.calcularNumeros(c(399.99));
  assert.strictEqual(r.numerosDevidos, 0);
  assert.strictEqual(r.saldoRemanescenteCents, c(399.99));
});
t('R$400,00 => 1 número', () => assert.strictEqual(core.calcularNumeros(c(400)).numerosDevidos, 1));
t('R$800,00 => 2 números', () => assert.strictEqual(core.calcularNumeros(c(800)).numerosDevidos, 2));
t('R$1.200,00 => 3 números', () => assert.strictEqual(core.calcularNumeros(c(1200)).numerosDevidos, 3));
t('R$1.550,00 => 3 números + R$350 remanescente', () => {
  const r = core.calcularNumeros(c(1550));
  assert.strictEqual(r.numerosDevidos, 3);
  assert.strictEqual(r.saldoRemanescenteCents, c(350));
});

console.log('\n== Acúmulo de saldo remanescente ==');
t('399,99 + 300,00 => 1 número, sobra 299,99', () => {
  const r = core.calcularNumeros(c(399.99) + c(300));
  assert.strictEqual(r.numerosDevidos, 1);
  assert.strictEqual(r.saldoRemanescenteCents, c(299.99));
});

console.log('\n== Validação de CPF ==');
t('CPF válido aceito', () => assert.ok(core.cpfValido('529.982.247-25')));
t('CPF inválido rejeitado', () => assert.ok(!core.cpfValido('111.111.111-11')));
t('CPF de dígitos errados rejeitado', () => assert.ok(!core.cpfValido('529.982.247-20')));

console.log('\n== Maioridade ==');
t('Nascido em 2010 é menor (bloqueado)', () => assert.ok(!core.maiorDeIdade('2010-01-01', new Date('2026-07-13'))));
t('Nascido em 2000 é maior', () => assert.ok(core.maiorDeIdade('2000-01-01', new Date('2026-07-13'))));

console.log('\n== Produtos vedados (valor elegível) ==');
t('Exclui item vedado do cálculo', () => {
  const v = core.valorElegivelNota(c(500), [{ valorCents: c(100), vedado: true }, { valorCents: c(400), vedado: false }]);
  assert.strictEqual(v, c(400));
});

console.log('\n== Unicidade dos números (alocação sequencial) ==');
t('10.000 números gerados sem duplicidade', () => {
  let cfg = { serieAtual: 1, proximoNumero: 0, tamanhoSerie: 100000, digitos: 5 };
  const res = core.alocarNumeros(10000, cfg);
  const set = new Set(res.numeros.map(n => n.serie + '-' + n.numero));
  assert.strictEqual(set.size, 10000);
});
t('Estouro de série abre nova série', () => {
  let cfg = { serieAtual: 1, proximoNumero: 99999, tamanhoSerie: 100000, digitos: 5 };
  const res = core.alocarNumeros(3, cfg);
  assert.strictEqual(res.numeros[0].serie, '01');
  assert.strictEqual(res.numeros[1].serie, '02'); // virou série
  assert.strictEqual(res.seriesConfig.serieAtual, 2);
});

console.log('\n== Integridade (hash encadeado) ==');
t('Hashes encadeados diferentes por número', () => {
  const h1 = core.hashNumero('GENESIS', 'C1', '01', '00001', 'cpfh', 'NF1', '2026-01-01');
  const h2 = core.hashNumero(h1, 'C1', '01', '00002', 'cpfh', 'NF1', '2026-01-01');
  assert.notStrictEqual(h1, h2);
  assert.strictEqual(h1.length, 64);
});

console.log('\n== Apuração (Loteria Federal) ==');
t('Número contemplado = último dígito dos 5 prêmios', () => {
  assert.strictEqual(core.numeroContempladoPadrao(['54321', '12678', '90123', '45674', '88895']), '18345');
});
t('Regra de aproximação quando número exato não existe', () => {
  const ativos = [
    { id: 'a', serie: '01', numero: '00010', participanteId: 'P1' },
    { id: 'b', serie: '01', numero: '00015', participanteId: 'P2' },
  ];
  const r = core.localizarGanhador('00012', ativos, '01');
  assert.strictEqual(r.ganhador.id, 'a'); // 12 -> mais próximo superior 15? não: superior +3=15, inferior -2=10 => inferior mais perto? loop d=1: sup13(no),inf11(no); d=2: sup14(no),inf10(SIM) => 10
  assert.ok(r.regra.startsWith('APROXIMACAO'));
});

console.log('\n== Chave NF-e / QR ==');
const base43 = '35' + '2408' + '12345678000199' + '65' + '001' + '000001234' + '1' + '12345678';
const chaveOK = base43 + core.validarDVChave(base43);
t('Chave com 44 dígitos e DV correto é válida', () => {
  const r = core.parseChaveNFe(chaveOK);
  assert.ok(r.valida, r.erro);
  assert.strictEqual(r.cnpjEmitente, '12345678000199');
  assert.strictEqual(r.ufSigla, 'SP');
  assert.strictEqual(r.anoMes, '2024-08');
});
t('Chave com DV errado é rejeitada', () => {
  const errada = base43 + ((core.validarDVChave(base43) + 1) % 10);
  assert.ok(!core.parseChaveNFe(errada).valida);
});
t('Extrai chave de dentro da URL do QR', () => {
  const url = `https://www.nfce.fazenda.sp.gov.br/qrcode?p=${chaveOK}|2|1|1|ABC123`;
  assert.strictEqual(core.extrairChaveDeQR(url), chaveOK);
});

console.log(`\nRESULTADO: ${ok} passaram, ${fail} falharam.\n`);
process.exit(fail ? 1 : 0);
