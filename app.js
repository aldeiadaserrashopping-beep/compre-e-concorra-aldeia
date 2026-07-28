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

// -------- Banner de cookies (LGPD) --------
// A escolha fica no navegador do visitante; nenhum dado é enviado ao servidor por aqui.
function cookies(aceitou) {
  try { localStorage.setItem('aldeia_cookies', aceitou ? 'aceitos' : 'necessarios'); } catch {}
  $('cookie-bar').classList.add('hidden');
}
(function initCookies() {
  let escolha = null;
  try { escolha = localStorage.getItem('aldeia_cookies'); } catch {}
  if (!escolha) $('cookie-bar').classList.remove('hidden');
})();

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
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    v.srcObject = stream; v.classList.remove('hidden'); await v.play();

    // Dois motores de leitura: BarcodeDetector (nativo, Chrome/Android) e jsQR
    // (reserva universal — iPhone/Safari não tem o nativo).
    const usarNativo = ('BarcodeDetector' in window);
    const det = usarNativo ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d', { willReadFrequently: true });

    const achou = (texto) => {
      $('n-qrtexto').value = texto;
      const chave = extrairChave(texto);
      if (chave) { $('n-chave').value = chave; lerChave(); }
      stream.getTracks().forEach(t => t.stop()); v.classList.add('hidden');
    };

    const loop = async () => {
      if (v.classList.contains('hidden')) return;
      try {
        if (usarNativo) {
          const codes = await det.detect(v);
          if (codes.length) return achou(codes[0].rawValue);
        } else if (window.jsQR && v.videoWidth) {
          // Reduz o quadro para 640px de largura: leitura rápida sem perder o QR
          const w = Math.min(640, v.videoWidth);
          const h = Math.round(v.videoHeight * w / v.videoWidth);
          cv.width = w; cv.height = h;
          ctx.drawImage(v, 0, 0, w, h);
          const img = ctx.getImageData(0, 0, w, h);
          const code = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
          if (code && code.data) return achou(code.data);
        }
      } catch {}
      // jsQR é mais pesado: escaneia ~6x/segundo em vez de a cada quadro
      usarNativo ? requestAnimationFrame(loop) : setTimeout(loop, 160);
    };
    loop();
  } catch {
    msg('n-msg', 'Não foi possível acessar a câmera. Permita o uso da câmera no navegador, ou digite a chave de 44 números que aparece abaixo do QR na nota.', false);
  }
}

function previewFoto() {
  const f = $('n-foto').files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      // ---- Triagem de qualidade ANTES de aceitar a foto ----
      // Barra os três defeitos que tornam a nota ilegível na moderação:
      // resolução baixa, foto escura e foto desfocada/tremida. Não lê o conteúdo
      // (isso segue com a moderação) — só garante que dá para ler.
      const problema = analisarFoto(img);
      if (problema) {
        FOTO_B64 = null; $('n-foto').value = ''; $('n-preview').classList.add('hidden');
        msg('n-msg', problema + ' Dica: se a nota for digital, envie o PRINT da tela em vez de fotografar o celular.', false);
        return;
      }
      const max = 1280, esc = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = img.width * esc; cv.height = img.height * esc;
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      FOTO_B64 = cv.toDataURL('image/jpeg', 0.7);
      $('n-preview').src = FOTO_B64; $('n-preview').classList.remove('hidden');
      msg('n-msg', 'Foto ok! Confira o valor e envie.', true);
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(f);
}

// Devolve a mensagem do problema, ou null se a foto está boa.
// Limiares propositalmente tolerantes: melhor deixar passar uma foto mediana
// (a moderação pega) do que travar um cliente com foto boa.
function analisarFoto(img) {
  if (Math.min(img.width, img.height) < 350)
    return 'A imagem está pequena demais para leitura. Tire a foto novamente, mais perto da nota.';
  const w = 512, h = Math.max(1, Math.round(img.height * w / img.width));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  // luminância média (0–255)
  const g = new Float32Array(w * h);
  let soma = 0;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    g[j] = y; soma += y;
  }
  const media = soma / (w * h);
  if (media < 35) return 'A foto está muito escura. Tire novamente em um lugar mais iluminado.';
  // nitidez: variância do laplaciano (foto tremida/desfocada tem valor baixo)
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      s += lap; s2 += lap * lap; n++;
    }
  }
  const variancia = s2 / n - (s / n) * (s / n);
  if (variancia < 20) return 'A foto parece tremida ou desfocada. Segure firme e tire novamente.';
  return null;
}

// -------- Tabela de notas (visão do participante) --------
function tabelaNotas(notas) {
  if (!notas.length) return '<small class="help">Nenhuma nota ainda.</small>';
  return '<table><tr><th>ID</th><th>Valor válido</th><th>Status</th></tr>' +
    notas.map(n => `<tr><td>${n.id}</td><td>${money((n.valorElegivelCents || 0) / 100)}</td>
      <td><span class="chip ${n.status}">${n.status.replace('_', ' ')}</span>${n.motivoRejeicao ? '<br><small class="help">' + n.motivoRejeicao + '</small>' : ''}</td></tr>`).join('') + '</table>';
}
