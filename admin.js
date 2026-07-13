'use strict';
let TOKEN = null;
const $ = (id) => document.getElementById(id);
const money = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',');
const msg = (id, t, ok) => { $(id).innerHTML = `<div class="msg ${ok ? 'ok' : 'err'}">${t}</div>`; };
const api = async (url, method = 'GET', body) => {
  const h = { 'Content-Type': 'application/json' };
  if (TOKEN) h['Authorization'] = 'Bearer ' + TOKEN;
  const r = await fetch(url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.mensagem || 'Erro') + (d.erro ? ` [${d.erro}]` : ''));
  return d;
};

async function adminLogin() {
  try {
    const r = await api('/api/v1/admin/login', 'POST', { email: $('a-email').value, senha: $('a-senha').value });
    TOKEN = r.token;
    $('login').classList.add('hidden'); $('painel').classList.remove('hidden');
    $('a-export').href = '/api/v1/admin/export/participantes.csv';
    dash(); listarNotas();
  } catch (e) { msg('a-msg', e.message, false); }
}

async function dash() {
  const d = await api('/api/v1/admin/dashboard');
  $('a-kpis').innerHTML =
    metric('Participantes', d.participantes) + metric('Notas', d.notas) +
    metric('Números ativos', d.numerosAtivos) + metric('Inutilizados', d.numerosInutilizados) +
    metric('Valor validado', money(d.valorValidado)) + metric('Autorização SPA', d.autorizadaSPA ? 'OK' : 'PENDENTE');
}

async function listarNotas() { $('a-notas').innerHTML = tabelaNotas(await api('/api/v1/admin/notas')); }
async function aprovar(id) { await api(`/api/v1/admin/notas/${id}/aprovar`, 'POST', {}); dash(); listarNotas(); }
async function rejeitar(id) { const m = prompt('Motivo da rejeição:', 'Nota ilegível'); if (m === null) return; await api(`/api/v1/admin/notas/${id}/rejeitar`, 'POST', { motivo: m }); dash(); listarNotas(); }
async function cancelar(id) { const m = prompt('Motivo do cancelamento:', 'Nota cancelada na SEFAZ'); if (m === null) return; await api(`/api/v1/admin/notas/${id}/cancelar`, 'POST', { motivo: m }); dash(); listarNotas(); }

async function apurar() {
  try {
    const premios = ['l1', 'l2', 'l3', 'l4', 'l5'].map(i => $(i).value);
    const r = await api('/api/v1/admin/sorteio/apurar', 'POST', { premiosLoteria: premios });
    $('a-sorteio').innerHTML = `<div class="msg ok">Apuração registrada · snapshot <code>${r.snapshotHash.slice(0, 16)}…</code></div>` +
      '<table><tr><th>Prêmio</th><th>Nº alvo</th><th>Regra</th><th>Contemplado</th><th>Ganhador</th></tr>' +
      r.ganhadores.map(g => `<tr><td>${g.premioOrdem}ª bike</td><td>${g.numeroAlvo}</td><td>${g.regra}</td><td>${g.numero || '—'}</td><td>${g.nome || 'SEM GANHADOR'}</td></tr>`).join('') + '</table>';
  } catch (e) { $('a-sorteio').innerHTML = `<div class="msg err">${e.message}</div>`; }
}

async function verAuditoria() {
  const r = await api('/api/v1/admin/auditoria');
  const i = r.integridade.ok ? `<div class="msg ok">Cadeia íntegra ✔ (${r.integridade.total} registros)</div>` : `<div class="msg err">Cadeia comprometida em ${r.integridade.quebrouEm}</div>`;
  $('a-aud').innerHTML = i + '<table><tr><th>Data</th><th>Entidade</th><th>Ação</th><th>Usuário</th></tr>' +
    r.registros.slice(-15).reverse().map(a => `<tr><td>${a.dataHora.slice(0, 19).replace('T', ' ')}</td><td>${a.entidade}</td><td>${a.acao}</td><td>${a.usuario}</td></tr>`).join('') + '</table>';
}

function tabelaNotas(notas) {
  if (!notas.length) return '<small class="help">Nenhuma nota ainda.</small>';
  return '<table><tr><th>ID</th><th>Origem</th><th>CNPJ</th><th>Evidência</th><th>Valor válido</th><th>Status</th><th>Ações</th></tr>' +
    notas.map(n => `<tr><td>${n.id}</td><td>${n.origem || '-'}</td><td>${n.cnpjEmitente || '-'}</td>
      <td>${n.fotoUrl ? `<a href="/${n.fotoUrl}" target="_blank">ver foto</a>` : '-'}</td>
      <td>${money((n.valorElegivelCents || 0) / 100)}</td>
      <td><span class="chip ${n.status}">${n.status.replace('_', ' ')}</span>${n.motivoRejeicao ? '<br><small class="help">' + n.motivoRejeicao + '</small>' : ''}</td>
      <td>${n.status === 'EM_ANALISE' ? `<button class="btn sm" onclick="aprovar('${n.id}')">Aprovar</button> <button class="btn ghost sm" onclick="rejeitar('${n.id}')">Rejeitar</button>` : ''}${n.status === 'APROVADA' ? `<button class="btn ghost sm" onclick="cancelar('${n.id}')">Cancelar</button>` : ''}</td>
    </tr>`).join('') + '</table>';
}
const metric = (t, v) => `<div class="metric">${t}<b>${v}</b></div>`;
