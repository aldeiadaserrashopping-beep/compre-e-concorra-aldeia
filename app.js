'use strict';
let TOKEN = null, PID = null, FOTO_B64 = null;
const $ = (id) => document.getElementById(id);
const money = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',');
const msg = (id, t, ok) => { $(id).innerHTML = `<div class="msg ${ok ? 'ok' : 'err'}">${t}</div>`; };

const api = async (url, method = 'GET', body, token) => {
  const h = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = 'Bearer ' + token;
  const r = await fetch(url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.mensagem || 'Erro') + (d.erro ? ` [${d.erro}]` : ''));
  return d;
};

// -------- Navegação de views (somente site do cliente; admin é página separada em /admin) --------
function irView(v) {
  ['home', 'area'].forEach(x => $('view-' + x).classList.toggle('hidden', x !== v));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('ativo', b.dataset.view === v));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => irView(b.dataset.view));

// -------- Stepper --------
function passo(n) {
  document.querySelectorAll('#stepper .step').forEach(s => s.classList.toggle('on', +s.dataset.s <= n));
}

// -------- Cadastro (auto-avança para a Minha Área) --------
async function cadastrar() {
  try {
    const d = {
      cpf: $('c-cpf').value, nome: $('c-nome').value, dataNascimento: $('c-nasc').value,
      telefone: $('c-tel').value, email: $('c-email').value, cidade: $('c-cidade').value, uf: $('c-uf').value,
      aceiteRegulamento: $('c-reg').checked, aceitePrivacidade: $('c-priv').checked,
      aceiteMarketing: $('c-mkt').checked, dispositivo: navigator.userAgent,
    };
    if (!d.aceiteRegulamento || !d.aceitePrivacidade) { msg('c-msg', 'Aceite o regulamento e a política de privacidade para continuar.', false); return; }
    const p = await api('/api/v1/participantes', 'POST', d);
    PID = p.id;
    msg('c-msg', 'Cadastro concluído! Redirecionando para a sua área…', true);
    passo(2);
    setTimeout(() => { irView('area'); entrarArea(p.nome); }, 700);
  } catch (e) { msg('c-msg', e.message, false); }
}

// -------- Login participante por CPF --------
async function loginParticipante() {
  try {
    const r = await api('/api/v1/participantes/login', 'POST', { cpf: $('p-cpf').value });
    PID = r.id;
    entrarArea();
  } catch (e) { msg('p-login-msg', e.message, false); }
}

function entrarArea(nome) {
  $('card-login-part').classList.add('hidden');
  $('p-painel').classList.remove('hidden');
  carregarParticipante(nome);
}

async function carregarParticipante(nome) {
  const r = await api(`/api/v1/participantes/${PID}/resumo`);
  const p = r.participante;
  if (nome || p.nome) $('p-nome').textContent = (nome || p.nome).split(' ')[0];
  $('m-valor').textContent = money(p.valorElegivel);
  $('m-num').textContent = p.numerosAtivos;
  const falta = 500 - p.saldoRemanescente;
  $('m-falta').textContent = money(falta === 500 ? 500 : falta);
  $('m-barra').style.width = Math.min(100, (p.saldoRemanescente / 500) * 100) + '%';
  $('p-numeros').innerHTML = r.numeros.length
    ? r.numeros.map(n => `<span class="num">${n}</span>`).join('')
    : '<small class="help">Você ainda não tem números. Envie suas notas para começar a concorrer.</small>';
  $('p-notas').innerHTML = tabelaNotas(r.notas, false);
  passo(r.numeros.length ? 3 : 2);
}

// -------- Envio de nota (QR + foto) --------
async function enviarNota() {
  try {
    if (!FOTO_B64) { msg('n-msg', 'Anexe a foto da nota (obrigatória).', false); return; }
    const d = {
      participanteId: PID, chaveNfe: $('n-chave').value.replace(/\D/g, ''), qrTexto: $('n-qrtexto').value || null,
      cnpjEmitente: $('n-cnpj').value, valorTotal: parseFloat($('n-valor').value || '0'),
      dataCompra: $('n-data').value || null, fotoBase64: FOTO_B64,
    };
    await api('/api/v1/notas', 'POST', d);
    msg('n-msg', 'Nota enviada! Assim que for validada, seus números aparecem aqui.', true);
    FOTO_B64 = null; ['n-foto', 'n-chave', 'n-cnpj', 'n-valor'].forEach(i => $(i).value = '');
    $('n-preview').classList.add('hidden'); $('n-lido').classList.add('hidden');
    carregarParticipante();
  } catch (e) { msg('n-msg', e.message, false); }
}

const UF = {'11':'RO','12':'AC','13':'AM','14':'RR','15':'PA','16':'AP','17':'TO','21':'MA','22':'PI','23':'CE','24':'RN','25':'PB','26':'PE','27':'AL','28':'SE','29':'BA','31':'MG','32':'ES','33':'RJ','35':'SP','41':'PR','42':'SC','43':'RS','50':'MS','51':'MT','52':'GO','53':'DF'};
const extrairChave = (t) => { const m = String(t).match(/(\d{44})/); return m ? m[1] : null; };
function lerChave() {
  const chave = extrairChave($('n-chave').value), box = $('n-lido');
  if (!chave) { box.classList.add('hidden'); return; }
  const cnpj = chave.slice(6, 20), aa = chave.slice(2, 4), mm = chave.slice(4, 6), uf = UF[chave.slice(0, 2)] || '?';
  $('n-cnpj').value = cnpj;
  box.classList.remove('hidden');
  box.textContent = `QR lido: CNPJ ${cnpj} · ${uf} · emissão ${mm}/20${aa}. Informe o valor e anexe a foto.`;
}

async function abrirScanner() {
  const v = $('qr-video');
  if (!('BarcodeDetector' in window)) {
    msg('n-msg', 'Seu navegador não lê QR automaticamente. Aponte a câmera do celular para o QR e cole o link/número no campo ao lado.', false);
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    v.srcObject = stream; v.classList.remove('hidden'); await v.play();
    const det = new BarcodeDetector({ formats: ['qr_code'] });
    const loop = async () => {
      if (v.classList.contains('hidden')) return;
      try {
        const codes = await det.detect(v);
        if (codes.length) {
          $('n-qrtexto').value = codes[0].rawValue;
          const chave = extrairChave(codes[0].rawValue);
          if (chave) { $('n-chave').value = chave; lerChave(); }
          stream.getTracks().forEach(t => t.stop()); v.classList.add('hidden'); return;
        }
      } catch {}
      requestAnimationFrame(loop);
    };
    loop();
  } catch { msg('n-msg', 'Não foi possível acessar a câmera. Cole o conteúdo do QR no campo.', false); }
}

function previewFoto() {
  const f = $('n-foto').files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = 1280, esc = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = img.width * esc; cv.height = img.height * esc;
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      FOTO_B64 = cv.toDataURL('image/jpeg', 0.7);
      $('n-preview').src = FOTO_B64; $('n-preview').classList.remove('hidden');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(f);
}

// -------- Tabela de notas (visão do participante) --------
function tabelaNotas(notas) {
  if (!notas.length) return '<small class="help">Nenhuma nota ainda.</small>';
  return '<table><tr><th>ID</th><th>Valor válido</th><th>Status</th></tr>' +
    notas.map(n => `<tr><td>${n.id}</td><td>${money((n.valorElegivelCents || 0) / 100)}</td>
      <td><span class="chip ${n.status}">${n.status.replace('_', ' ')}</span>${n.motivoRejeicao ? '<br><small class="help">' + n.motivoRejeicao + '</small>' : ''}</td></tr>`).join('') + '</table>';
}
