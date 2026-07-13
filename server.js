'use strict';
/**
 * Servidor HTTP (Node puro, sem dependências) — protótipo funcional.
 * Portal do participante + Painel administrativo + API + trilha de auditoria.
 * Uso: node server.js  ->  http://localhost:3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const svc = require('./service');
const core = require('./core');

const PORT = process.env.PORT || 3000;

// ---------- Rate limit simples por IP (Seção 9) ----------
const hits = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const janela = 60000, max = 120;
  const arr = (hits.get(ip) || []).filter(t => now - t < janela);
  arr.push(now); hits.set(ip, arr);
  return arr.length <= max;
}

// ---------- Sessões admin (token em memória) ----------
const sessoes = new Map();
function novaSessao(usuario) { const t = crypto.randomBytes(16).toString('hex'); sessoes.set(t, { usuario, criadoEm: Date.now() }); return t; }
function auth(req) { const t = (req.headers['authorization'] || '').replace('Bearer ', ''); return sessoes.get(t); }

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function erroHandler(res, e) {
  if (e.publico) return send(res, 400, { erro: e.codigo || 'ERRO', mensagem: e.message });
  console.error(e);
  return send(res, 500, { erro: 'E-SIS', mensagem: 'Erro interno.' });
}

function body(req) {
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 15e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(Object.assign(new Error('JSON inválido'), { publico: true, codigo: 'E-JSON' })); } });
  });
}

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress;
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (!rateLimit(ip)) return send(res, 429, { erro: 'E-SEG-01', mensagem: 'Muitas requisições. Aguarde.' });

  try {
    // -------- Static --------
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, 'index.html', 'text/html');
    if (req.method === 'GET' && p === '/app.js') return serveFile(res, 'app.js', 'application/javascript');
    if (req.method === 'GET' && p === '/logo.svg') return serveFile(res, 'logo.svg', 'image/svg+xml');
    // Painel administrativo — página separada do site do cliente
    if (req.method === 'GET' && (p === '/admin' || p === '/admin.html')) return serveFile(res, 'admin.html', 'text/html');
    if (req.method === 'GET' && p === '/admin.js') return serveFile(res, 'admin.js', 'application/javascript');
    // Evidências (fotos das notas). Protótipo: nome de arquivo não adivinhável.
    // PRODUÇÃO: usar URL assinada/temporária com verificação de perfil (Seção 9).
    if (req.method === 'GET' && p.startsWith('/data/uploads/')) {
      const nome = path.basename(p);
      const tipo = nome.endsWith('.png') ? 'image/png' : nome.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      return serveFile(res, path.join('data', 'uploads', nome), tipo);
    }

    // -------- API pública --------
    if (req.method === 'GET' && p === '/api/v1/campanha') {
      const c = db.load().campanha;
      return send(res, 200, { id: c.id, nome: c.nome, valorUnidade: c.valorUnidade, qtdPremios: c.qtdPremios,
        dataInicio: c.dataInicio, dataFim: c.dataFim, autorizada: !!c.numCertificadoSPA, status: c.status });
    }

    if (req.method === 'POST' && p === '/api/v1/participantes') {
      const dados = await body(req);
      return send(res, 201, svc.cadastrarParticipante(dados, ip));
    }

    if (req.method === 'POST' && p === '/api/v1/notas') {
      const dados = await body(req);
      if (!dados.participanteId) throw pub('E-VAL', 'participanteId obrigatório.');
      return send(res, 201, svc.enviarNota(dados.participanteId, dados, ip));
    }

    if (req.method === 'POST' && p === '/api/v1/participantes/login') {
      const { cpf } = await body(req);
      const alvo = String(cpf || '').replace(/\D/g, '');
      const part = db.load().participantes.find(x => x.id && require('./core').cpfHash(alvo) === x.cpfHash);
      if (!part) throw pub('E-AUTH-04', 'CPF não cadastrado. Faça seu cadastro primeiro.');
      return send(res, 200, { id: part.id });
    }

    if (req.method === 'GET' && p.match(/^\/api\/v1\/participantes\/[^/]+\/resumo$/)) {
      const id = p.split('/')[4];
      const store = db.load();
      const part = store.participantes.find(x => x.id === id);
      if (!part) throw pub('E-404', 'Participante não encontrado.');
      const notas = store.notas.filter(n => n.participanteId === id);
      const numeros = store.numeros.filter(n => n.participanteId === id && n.status === 'ATIVO')
        .map(n => `${n.serie}-${n.numero}`);
      return send(res, 200, { participante: svc.publicoParticipante(part), notas, numeros });
    }

    // -------- Auth admin --------
    if (req.method === 'POST' && p === '/api/v1/admin/login') {
      const { email, senha } = await body(req);
      const u = db.load().usuarios.find(x => x.email === email && x.ativo);
      if (!u || u.senhaHash !== db.hashSenha(senha)) throw pub('E-AUTH-01', 'E-mail ou senha incorretos.');
      db.auditar({ entidade: 'usuario', entidadeId: u.id, acao: 'LOGIN', usuario: u.email, ip });
      return send(res, 200, { token: novaSessao(u.email), nome: u.nome, perfil: u.perfil });
    }

    // -------- API admin (protegida) --------
    if (p.startsWith('/api/v1/admin/')) {
      const s = auth(req);
      if (!s) return send(res, 401, { erro: 'E-AUTH-02', mensagem: 'Não autenticado.' });
      const usuario = s.usuario;

      if (req.method === 'GET' && p === '/api/v1/admin/dashboard') {
        const st = db.load();
        const porStatus = st.notas.reduce((a, n) => (a[n.status] = (a[n.status] || 0) + 1, a), {});
        return send(res, 200, {
          participantes: st.participantes.length,
          notas: st.notas.length, notasPorStatus: porStatus,
          numerosAtivos: st.numeros.filter(n => n.status === 'ATIVO').length,
          numerosInutilizados: st.numeros.filter(n => n.status === 'INUTILIZADO').length,
          valorValidado: core.fromCents(st.notas.filter(n => n.status === 'APROVADA').reduce((s, n) => s + n.valorElegivelCents, 0)),
          autorizadaSPA: !!st.campanha.numCertificadoSPA,
        });
      }
      if (req.method === 'GET' && p === '/api/v1/admin/notas') {
        return send(res, 200, db.load().notas);
      }
      if (req.method === 'GET' && p === '/api/v1/admin/participantes') {
        return send(res, 200, db.load().participantes.map(svc.publicoParticipante));
      }
      if (req.method === 'POST' && p.match(/^\/api\/v1\/admin\/notas\/[^/]+\/aprovar$/)) {
        return send(res, 200, svc.aprovarNota(p.split('/')[5], usuario, ip));
      }
      if (req.method === 'POST' && p.match(/^\/api\/v1\/admin\/notas\/[^/]+\/rejeitar$/)) {
        const { motivo } = await body(req);
        return send(res, 200, svc.rejeitarNota(p.split('/')[5], motivo || 'Não especificado', usuario, ip));
      }
      if (req.method === 'POST' && p.match(/^\/api\/v1\/admin\/notas\/[^/]+\/cancelar$/)) {
        const { motivo } = await body(req);
        return send(res, 200, svc.cancelarNota(p.split('/')[5], motivo || 'Não especificado', usuario, ip));
      }
      if (req.method === 'POST' && p === '/api/v1/admin/sorteio/apurar') {
        const { premiosLoteria } = await body(req);
        if (!Array.isArray(premiosLoteria) || premiosLoteria.length < 5) throw pub('E-SORT', 'Informe os 5 prêmios da Loteria Federal.');
        return send(res, 200, svc.apurar(premiosLoteria, usuario, ip));
      }
      if (req.method === 'GET' && p === '/api/v1/admin/auditoria') {
        return send(res, 200, { integridade: db.verificarAuditoria(), registros: db.load().auditoria.slice(-200) });
      }
      if (req.method === 'GET' && p === '/api/v1/admin/export/participantes.csv') {
        const rows = [['id', 'nome', 'cpf_mascarado', 'cidade', 'uf', 'valor_elegivel', 'numeros_ativos']];
        db.load().participantes.forEach(pt => rows.push([pt.id, pt.nome, mask(pt.cpf), pt.cidade, pt.uf, core.fromCents(pt.valorElegivelCents), pt.numerosAtivos]));
        const csv = rows.map(r => r.join(';')).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename=participantes.csv' });
        return res.end(csv);
      }
    }

    return send(res, 404, { erro: 'E-404', mensagem: 'Rota não encontrada.' });
  } catch (e) { return erroHandler(res, e); }
});

function serveFile(res, rel, type) {
  try {
    const data = fs.readFileSync(path.join(__dirname, rel));
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
}
function pub(c, m) { const e = new Error(m); e.publico = true; e.codigo = c; return e; }
function mask(cpf) { return String(cpf).replace(/^(\d{3})\d{6}(\d{2})$/, '$1.***.***-$2'); }

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    const nets = require('os').networkInterfaces();
    let lan = null;
    for (const nome of Object.keys(nets))
      for (const n of nets[nome]) if (n.family === 'IPv4' && !n.internal) { lan = n.address; break; }
    console.log('\n  ╔══════════════════════════════════════════════════════╗');
    console.log('  ║   Compre e Concorra · Shopping Aldeia da Serra        ║');
    console.log('  ╚══════════════════════════════════════════════════════╝\n');
    console.log(`  Neste computador:   http://localhost:${PORT}`);
    if (lan) console.log(`  Para o time (mesma rede Wi-Fi):  http://${lan}:${PORT}`);
    console.log(`  Painel do admin:    http://localhost:${PORT}/admin`);
    console.log('\n  Para encerrar, feche esta janela ou pressione Ctrl + C.\n');
  });
}
module.exports = server;
