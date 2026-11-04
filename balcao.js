'use strict';
/**
 * Terminal do balcão de retirada — Natal Luz 2026.
 *
 * Desenhado para uso com fila na frente: um campo de CPF, um veredito grande e
 * um botão. A decisão de entregar ou não precisa ser legível de relance, sem
 * a atendente precisar interpretar valores ou status.
 *
 * O token fica só em memória: se o tablet for bloqueado ou a aba fechar, a
 * sessão cai. É proposital — é um aparelho compartilhado no piso do shopping.
 */
let TOKEN = null;
let ATUAL = null;   // resultado da última consulta

const $ = (id) => document.getElementById(id);
const mostrar = (el, sim) => el.classList.toggle('oculto', !sim);

function erro(el, msg) {
  el.textContent = msg;
  mostrar(el, true);
}
function limparErro(el) { mostrar(el, false); }

async function api(caminho, opcoes = {}) {
  const r = await fetch(caminho, {
    ...opcoes,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(opcoes.headers || {}),
    },
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.mensagem || 'Falha na comunicação com o servidor.');
  return dados;
}

// ---------------------------------------------------------------- login
async function entrar() {
  limparErro($('erroLogin'));
  const email = $('email').value.trim();
  const senha = $('senha').value;
  if (!email || !senha) return erro($('erroLogin'), 'Informe e-mail e senha.');

  $('btnEntrar').disabled = true;
  try {
    const r = await api('/api/v1/admin/login', {
      method: 'POST', body: JSON.stringify({ email, senha }),
    });
    TOKEN = r.token;
    $('sub').textContent = `${r.nome} · Shopping Aldeia da Serra`;
    mostrar($('telaLogin'), false);
    mostrar($('telaBusca'), true);
    $('boxEstoque').hidden = false;
    $('senha').value = '';
    await atualizarEstoque();
    $('cpf').focus();
  } catch (e) {
    erro($('erroLogin'), e.message);
  } finally {
    $('btnEntrar').disabled = false;
  }
}

async function atualizarEstoque() {
  try {
    const e = await api('/api/v1/balcao/estoque');
    $('estDisp').textContent = e.disponiveis;
    $('estDisp').style.color = e.disponiveis === 0 ? '#ffc9c9'
      : e.disponiveis <= 20 ? '#ffe08a' : '#fff';
  } catch { /* o contador é informativo; falhar nele não pode travar o atendimento */ }
}

// ------------------------------------------------------------- consulta
function formatarCpf(v) {
  const d = v.replace(/\D/g, '').slice(0, 11);
  return d.replace(/(\d{3})(\d)/, '$1.$2')
          .replace(/(\d{3})(\d)/, '$1.$2')
          .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}

async function buscar() {
  limparErro($('erroBusca'));
  mostrar($('telaResultado'), false);
  const cpf = $('cpf').value.replace(/\D/g, '');
  if (cpf.length !== 11) return erro($('erroBusca'), 'Digite os 11 dígitos do CPF.');

  $('btnBuscar').disabled = true;
  try {
    ATUAL = await api('/api/v1/balcao/consultar', {
      method: 'POST', body: JSON.stringify({ cpf }),
    });
    desenhar(ATUAL);
    mostrar($('telaResultado'), true);
    $('telaResultado').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    erro($('erroBusca'), e.message);
  } finally {
    $('btnBuscar').disabled = false;
  }
}

function desenhar(d) {
  const dir = d.direito;
  const box = $('situacao');
  const podeEntregar = dir && dir.status === 'QUALIFICADO';

  if (dir && dir.status === 'RETIRADO') {
    box.className = 'situacao ja';
    box.innerHTML = `<div class="icone">✓</div><h2>Brinde já retirado</h2>
      <p>Retirado em ${dataHora(dir.retiradoEm)}${dir.atendente ? ' por ' + escapar(dir.atendente) : ''}.
      O limite é de 1 brinde por CPF.</p>`;
  } else if (podeEntregar) {
    box.className = 'situacao pode';
    box.innerHTML = `<div class="icone">🎁</div><h2>Pode retirar</h2>
      <p>${escapar(d.participante.nome)} atingiu R$ ${d.valorElegivel.toFixed(2).replace('.', ',')} em compras válidas.</p>`;
  } else {
    box.className = 'situacao nao';
    const falta = d.faltam.toFixed(2).replace('.', ',');
    box.innerHTML = `<div class="icone">✕</div><h2>Ainda não pode retirar</h2>
      <p>Faltam R$ ${falta} em compras válidas para atingir o mínimo de
      R$ ${d.minimo.toFixed(2).replace('.', ',')}.</p>`;
  }

  $('dados').innerHTML = [
    ['Cliente', escapar(d.participante.nome)],
    ['CPF', escapar(d.participante.cpf)],
    ['Acumulado válido', 'R$ ' + d.valorElegivel.toFixed(2).replace('.', ',')],
    ['Telefone', escapar(d.participante.telefone || '—')],
  ].map(([r, v]) => `<div class="dado"><span>${r}</span><b>${v}</b></div>`).join('');

  mostrar($('blocoEntrega'), podeEntregar);
  limparErro($('erroEntrega'));
  $('doc').value = '';
  $('obs').value = '';

  const linhas = (d.notas || []).map(n => `
    <tr>
      <td>${escapar(n.loja || n.cnpjEmitente || '—')}</td>
      <td>${n.dataCompra ? dataBr(n.dataCompra) : '—'}</td>
      <td>R$ ${Number(n.valor).toFixed(2).replace('.', ',')}</td>
      <td><span class="tag ${escapar(n.status)}">${rotulo(n.status)}</span>
        ${n.motivoRejeicao ? '<br><small>' + escapar(n.motivoRejeicao) + '</small>' : ''}</td>
      <td><a class="foto" href="/api/v1/balcao/notas/${encodeURIComponent(n.id)}/foto?token=${encodeURIComponent(TOKEN)}"
             target="_blank" rel="noopener">ver</a></td>
    </tr>`).join('');
  $('tbNotas').innerHTML = linhas;
  mostrar($('semNotas'), !linhas);
}

// ------------------------------------------------------------- entrega
async function entregar() {
  limparErro($('erroEntrega'));
  const doc = $('doc').value.trim();
  if (doc.length < 4)
    return erro($('erroEntrega'), 'Registre o documento com foto que você conferiu.');
  if (!ATUAL || !ATUAL.direito) return;

  $('btnEntregar').disabled = true;
  try {
    const r = await api('/api/v1/balcao/entregar', {
      method: 'POST',
      body: JSON.stringify({
        direitoId: ATUAL.direito.id,
        documentoConferido: doc,
        observacao: $('obs').value.trim() || null,
      }),
    });
    $('situacao').className = 'situacao ja';
    $('situacao').innerHTML = `<div class="icone">✓</div><h2>Entrega registrada</h2>
      <p>${escapar(r.participante.nome)} recebeu o brinde.
      Restam ${r.estoque.disponiveis} de ${r.estoque.total} unidades.</p>`;
    mostrar($('blocoEntrega'), false);
    await atualizarEstoque();
    // Limpa o campo para o próximo da fila, sem apagar a confirmação da tela.
    $('cpf').value = '';
    $('cpf').focus();
  } catch (e) {
    erro($('erroEntrega'), e.message);
    await atualizarEstoque();
  } finally {
    $('btnEntregar').disabled = false;
  }
}

function limpar() {
  $('cpf').value = '';
  ATUAL = null;
  mostrar($('telaResultado'), false);
  limparErro($('erroBusca'));
  $('cpf').focus();
}

// ------------------------------------------------------------- utilidades
function escapar(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function rotulo(s) {
  return { APROVADA: 'Aprovada', EM_ANALISE: 'Em análise',
           REJEITADA: 'Rejeitada', CANCELADA: 'Cancelada' }[s] || s;
}
function dataBr(iso) {
  const [a, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}
function dataHora(iso) {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch { return dataBr(iso); }
}

// ------------------------------------------------------------- ligações
$('btnEntrar').addEventListener('click', entrar);
$('senha').addEventListener('keydown', e => { if (e.key === 'Enter') entrar(); });
$('btnBuscar').addEventListener('click', buscar);
$('btnLimpar').addEventListener('click', limpar);
$('btnEntregar').addEventListener('click', entregar);
$('cpf').addEventListener('input', e => { e.target.value = formatarCpf(e.target.value); });
$('cpf').addEventListener('keydown', e => { if (e.key === 'Enter') buscar(); });

// Mantém o contador de estoque fresco: duas atendentes podem estar trabalhando
// em tablets diferentes, e a fila decide com base nesse número.
setInterval(() => { if (TOKEN) atualizarEstoque(); }, 30000);
