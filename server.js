'use strict';
/**
 * Servidor HTTP (Node puro) — Aldeia Premia.
 * Portal do participante + Painel administrativo + API + trilha de auditoria.
 * Uso: node server.js  ->  http://localhost:3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store-pg');
const svc = require('./service');
const core = require('./core');
const CAMPANHA = require('./campanha.config');

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
// Impede o Map de crescer sem limite com o tempo (um IP por visitante).
setInterval(() => {
  const corte = Date.now() - 60000;
  for (const [ip, arr] of hits) if (!arr.some(t => t > corte)) hits.delete(ip);
}, 60000).unref();

// ---------- Sessões admin (token em memória) ----------
const sessoes = new Map();
const VALIDADE_SESSAO = 8 * 3600 * 1000; // 8 horas
function novaSessao(usuario, perfil) {
  const t = crypto.randomBytes(32).toString('hex');
  sessoes.set(t, { usuario, perfil, criadoEm: Date.now() });
  return t;
}
// Token pelo cabeçalho Authorization ou, para downloads (<a href>), pela query ?token=
function auth(req, url) {
  const t = (req.headers['authorization'] || '').replace('Bearer ', '')
    || (url && url.searchParams.get('token')) || '';
  const s = sessoes.get(t);
  if (!s) return null;
  if (Date.now() - s.criadoEm > VALIDADE_SESSAO) { sessoes.delete(t); return null; }
  return s;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function erroHandler(res, e) {
  if (e.publico) return send(res, 400, { erro: e.codigo || 'ERRO', mensagem: e.message });
  // Violações de unicidade do banco são a última barreira contra corrida: viram
  // mensagem de negócio, não erro 500.
  if (e.code === '23505') {
    const dup = /chave_nfe/.test(e.detail || '') ? 'Esta nota já foi cadastrada.'
      : /cpf_hash/.test(e.detail || '') ? 'Este CPF já possui cadastro.'
      : 'Registro duplicado.';
    return send(res, 400, { erro: 'E-DUP', mensagem: dup });
  }
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
  // Atrás do proxy do Render, req.socket.remoteAddress é o proxy — o IP real do
  // participante (que é prova de consentimento LGPD) vem no X-Forwarded-For.
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  const ua = req.headers['user-agent'] || null;
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (!rateLimit(ip)) return send(res, 429, { erro: 'E-SEG-01', mensagem: 'Muitas requisições. Aguarde.' });

  try {
    // -------- Static --------
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, 'index.html', 'text/html');
    if (req.method === 'GET' && p === '/app.js') return serveFile(res, 'app.js', 'application/javascript');
    if (req.method === 'GET' && p === '/logo.svg') return serveFile(res, 'logo.svg', 'image/svg+xml');
    if (req.method === 'GET' && p === '/arte-campanha.jpg') return serveFile(res, 'arte-campanha.jpg', 'image/jpeg');
    // Páginas jurídicas (LGPD) — públicas
    if (req.method === 'GET' && (p === '/politica-de-privacidade' || p === '/politica.html'))
      return serveFile(res, 'politica.html', 'text/html');
    if (req.method === 'GET' && (p === '/regulamento' || p === '/regulamento.html'))
      return serveFile(res, 'regulamento.html', 'text/html');
    // Painel administrativo — página separada do site do cliente
    if (req.method === 'GET' && (p === '/admin' || p === '/admin.html')) return serveFile(res, 'admin.html', 'text/html');
    if (req.method === 'GET' && p === '/admin.js') return serveFile(res, 'admin.js', 'application/javascript');

    // -------- API pública --------
    if (req.method === 'GET' && p === '/api/v1/campanha') {
      const c = await store.getCampanha(null, CAMPANHA.id);
      return send(res, 200, { id: c.id, nome: c.nome, valorUnidade: c.valorUnidade, qtdPremios: c.qtdPremios,
        dataInicio: c.dataInicio, dataFim: c.dataFim, autorizada: !!c.numCertificadoSPA,
        certificadoSPA: c.numCertificadoSPA, status: c.status });
    }

    if (req.method === 'POST' && p === '/api/v1/participantes') {
      const dados = await body(req);
      return send(res, 201, await svc.cadastrarParticipante(dados, ip, ua));
    }

    if (req.method === 'POST' && p === '/api/v1/notas') {
      const dados = await body(req);
      if (!dados.participanteId) throw pub('E-VAL', 'participanteId obrigatório.');
      return send(res, 201, await svc.enviarNota(dados.participanteId, dados, ip, ua));
    }

    if (req.method === 'POST' && p === '/api/v1/participantes/login') {
      const { cpf } = await body(req);
      const alvo = String(cpf || '').replace(/\D/g, '');
      const part = await store.getParticipantePorCpfHash(null, core.cpfHash(alvo));
      if (!part) throw pub('E-AUTH-04', 'CPF não cadastrado. Faça seu cadastro primeiro.');
      return send(res, 200, { id: part.id });
    }

    if (req.method === 'GET' && p.match(/^\/api\/v1\/participantes\/[^/]+\/resumo$/)) {
      const id = p.split('/')[4];
      const part = await store.getParticipante(null, id);
      if (!part) throw pub('E-404', 'Participante não encontrado.');
      const notas = await store.notasDoParticipante(null, id);
      const nums = await store.numerosDoParticipante(null, id, 'ATIVO');
      return send(res, 200, {
        participante: svc.publicoParticipante(part),
        notas: notas.map(n => ({ ...n, valorTotal: core.fromCents(n.valorTotalCents) })),
        numeros: nums.map(n => `${n.serie}-${n.numero}`),
      });
    }

    // -------- Auth admin --------
    if (req.method === 'POST' && p === '/api/v1/admin/login') {
      const { email, senha } = await body(req);
      const u = await store.getUsuarioPorEmail(null, String(email || ''));
      // Confere a senha mesmo com usuário inexistente: sem isso, a diferença de
      // tempo de resposta revelaria quais e-mails existem.
      const ok = u ? store.conferirSenha(senha, u.senhaHash)
                   : store.conferirSenha(senha, store.hashSenha('inexistente'));
      if (!u || !ok) {
        await store.auditar(null, { entidade: 'usuario', acao: 'LOGIN_FALHA', usuario: String(email || ''), ip, userAgent: ua });
        throw pub('E-AUTH-01', 'E-mail ou senha incorretos.');
      }
      await store.auditar(null, { entidade: 'usuario', entidadeId: u.id, acao: 'LOGIN', usuario: u.email, ip, userAgent: ua });
      return send(res, 200, { token: novaSessao(u.email, u.perfil), nome: u.nome, perfil: u.perfil });
    }

    // -------- API admin (protegida) --------
    if (p.startsWith('/api/v1/admin/')) {
      const s = auth(req, url);
      if (!s) return send(res, 401, { erro: 'E-AUTH-02', mensagem: 'Não autenticado.' });
      const usuario = s.usuario;

      if (req.method === 'GET' && p === '/api/v1/admin/dashboard') {
        const notas = await store.listarNotas(null);
        const campanha = await store.getCampanha(null, CAMPANHA.id);
        const porStatus = notas.reduce((a, n) => (a[n.status] = (a[n.status] || 0) + 1, a), {});
        return send(res, 200, {
          participantes: (await store.listarParticipantes(null)).length,
          notas: notas.length, notasPorStatus: porStatus,
          numerosAtivos: await store.contarNumeros(null, 'ATIVO'),
          numerosInutilizados: await store.contarNumeros(null, 'INUTILIZADO'),
          valorValidado: core.fromCents(notas.filter(n => n.status === 'APROVADA').reduce((t, n) => t + n.valorElegivelCents, 0)),
          autorizadaSPA: !!campanha.numCertificadoSPA,
        });
      }
      if (req.method === 'GET' && p === '/api/v1/admin/notas') {
        const notas = await store.listarNotas(null);
        return send(res, 200, notas.map(n => ({
          ...n, valorTotal: core.fromCents(n.valorTotalCents),
          valorElegivel: core.fromCents(n.valorElegivelCents), fotoUrl: `/api/v1/admin/notas/${n.id}/foto`,
        })));
      }
      if (req.method === 'GET' && p === '/api/v1/admin/participantes') {
        return send(res, 200, (await store.listarParticipantes(null)).map(svc.publicoParticipante));
      }
      // Evidência da nota — servida do banco, só para quem está autenticado.
      if (req.method === 'GET' && p.match(/^\/api\/v1\/admin\/notas\/[^/]+\/foto$/)) {
        const f = await store.getFoto(p.split('/')[5]);
        if (!f) return send(res, 404, { erro: 'E-404', mensagem: 'Foto não encontrada.' });
        res.writeHead(200, { 'Content-Type': f.mime, 'Cache-Control': 'private, max-age=300' });
        return res.end(f.bytes);
      }
      if (req.method === 'POST' && p.match(/^\/api\/v1\/admin\/notas\/[^/]+\/aprovar$/)) {
        return send(res, 200, await svc.aprovarNota(p.split('/')[5], usuario, ip));
      }
      if (req.method === 'POST' && p.match(/^\/api\/v1\/admin\/notas\/[^/]+\/rejeitar$/)) {
        const { motivo } = await body(req);
        return send(res, 200, await svc.rejeitarNota(p.split('/')[5], motivo || 'Não especificado', usuario, ip));
      }
      if (req.method === 'POST' && p.match(/^\/api\/v1\/admin\/notas\/[^/]+\/cancelar$/)) {
        const { motivo } = await body(req);
        return send(res, 200, await svc.cancelarNota(p.split('/')[5], motivo || 'Não especificado', usuario, ip));
      }
      if (req.method === 'POST' && p === '/api/v1/admin/sorteio/apurar') {
        const { numeroSorteado } = await body(req);
        const n = String(numeroSorteado || '').replace(/\D/g, '');
        if (n.length < 1 || n.length > 5) throw pub('E-SORT', 'Informe o número sorteado na plataforma (1 a 5 dígitos).');
        return send(res, 200, await svc.apurar(n, usuario, ip));
      }
      if (req.method === 'GET' && p === '/api/v1/admin/auditoria') {
        return send(res, 200, {
          integridade: await store.verificarAuditoria(),
          numeros: await store.verificarNumeros(),
          registros: await store.listarAuditoria(200),
        });
      }
      // ---- LISTA DE PARTICIPANTES no layout do SCPC (Nota 23, de 16/04/2026) ----
      // Carga na aba "Apurações" da "Prestação de Contas". CSV, separador vírgula,
      // aspas duplas como delimitador opcional, máx. 250MB por arquivo.
      // Cabeçalho exato: cpf,cnpj,nome,numero_serie,elemento_sorteavel,data_hora_participacao,email,telefone,estrangeiro
      if (req.method === 'GET' && p === '/api/v1/admin/export/lista-participantes-scpc.csv') {
        const lista = await store.listaSCPC();
        const linhas = ['cpf,cnpj,nome,numero_serie,elemento_sorteavel,data_hora_participacao,email,telefone,estrangeiro'];
        for (const r of lista) {
          linhas.push([
            String(r.cpf || '').replace(/\D/g, ''),               // 1 cpf — 11 dígitos
            '',                                                   // 2 cnpj — vazio (participantes são pessoas físicas)
            csvEsc(r.nome || ''),                                 // 3 nome — 6..100
            String(parseInt(r.serie, 10)),                        // 4 numero_serie — 1..8 dígitos
            String(r.numero),                                     // 5 elemento_sorteavel — 1..5 dígitos
            dataHoraSCPC(r.emitidoEm),                            // 6 data_hora_participacao
            csvEsc(r.email || ''),                                // 7 email (opcional)
            csvEsc(String(r.telefone || '').replace(/\D/g, '')),  // 8 telefone (opcional)
            '',                                                   // 9 estrangeiro (opcional: sim/yes)
          ].join(','));
        }
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename=lista_participantes_scpc.csv' });
        return res.end(linhas.join('\r\n'));
      }

      // Valida a lista contra as regras do SCPC antes de enviar (evita recusa do arquivo)
      if (req.method === 'GET' && p === '/api/v1/admin/export/lista-participantes-scpc/validar') {
        const lista = await store.listaSCPC();
        const problemas = [];
        for (const r of lista) {
          const cpf = String(r.cpf || '').replace(/\D/g, '');
          const nome = String(r.nome || '');
          const tel = String(r.telefone || '').replace(/\D/g, '');
          const email = String(r.email || '');
          if (cpf.length !== 11) problemas.push({ numero: r.numero, cpf, erro: 'CPF deve ter 11 dígitos.' });
          if (nome.length < 6 || nome.length > 100) problemas.push({ numero: r.numero, cpf, erro: `Nome deve ter 6 a 100 caracteres (tem ${nome.length}).` });
          if (String(r.numero).length > 5) problemas.push({ numero: r.numero, cpf, erro: 'Elemento sorteável excede 5 dígitos.' });
          if (String(parseInt(r.serie, 10)).length > 8) problemas.push({ numero: r.numero, cpf, erro: 'Número de série excede 8 dígitos.' });
          if (email && (email.length < 6 || email.length > 70)) problemas.push({ numero: r.numero, cpf, erro: `E-mail deve ter 6 a 70 caracteres (tem ${email.length}).` });
          if (tel && (tel.length < 10 || tel.length > 20)) problemas.push({ numero: r.numero, cpf, erro: `Telefone deve ter 10 a 20 caracteres (tem ${tel.length}).` });
        }
        return send(res, 200, { totalLinhas: lista.length, ok: problemas.length === 0, problemas: problemas.slice(0, 200), totalProblemas: problemas.length });
      }

      if (req.method === 'GET' && p === '/api/v1/admin/export/participantes.csv') {
        const rows = [['id', 'nome', 'cpf_mascarado', 'cidade', 'uf', 'valor_elegivel', 'numeros_ativos']];
        (await store.listarParticipantes(null)).forEach(pt =>
          rows.push([pt.id, pt.nome, svc.mascararCpf(pt.cpf), pt.cidade, pt.uf, core.fromCents(pt.valorElegivelCents), pt.numerosAtivos]));
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

// Escape CSV conforme SCPC: aspas duplas como delimitador opcional; obrigatório
// quando o conteúdo tiver vírgula (ex.: "Razão Social, ME"). Aspas internas são duplicadas.
function csvEsc(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// data_hora_participacao no formato DD/MM/AAAA HH:MM:SS, sempre no fuso de Brasília
// (o servidor em produção roda em UTC; sem isso a hora sairia adiantada).
function dataHoraSCPC(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const f = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const x = Object.fromEntries(f.formatToParts(d).map(y => [y.type, y.value]));
  return `${x.day}/${x.month}/${x.year} ${x.hour}:${x.minute}:${x.second}`;
}

async function subir() {
  // O banco é criado/migrado antes de aceitar a primeira requisição. Se falhar,
  // o processo morre e o Render mantém a versão anterior no ar — melhor do que
  // atender participante com banco meio configurado.
  await store.init(CAMPANHA);
  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  ╔══════════════════════════════════════════════════════╗');
    console.log('  ║   Aldeia Premia · Shopping Aldeia da Serra            ║');
    console.log('  ╚══════════════════════════════════════════════════════╝\n');
    console.log(`  Portal:   http://localhost:${PORT}`);
    console.log(`  Painel:   http://localhost:${PORT}/admin`);
    console.log(`  Banco:    conectado`);
    console.log(`  Campanha: ${CAMPANHA.dataInicio} a ${CAMPANHA.dataFim}`);
    console.log(`  SPA/MF:   ${CAMPANHA.numCertificadoSPA || 'certificado ainda não informado (modo pré-autorização)'}\n`);
  });
}

if (require.main === module) {
  subir().catch(e => { console.error('Falha ao subir:', e.message); process.exit(1); });
}
module.exports = { server, subir };
