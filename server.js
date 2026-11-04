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
const email = require('./email');
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
    if (req.method === 'GET' && p === '/icone.svg') return serveFile(res, 'icone.svg', 'image/svg+xml');
    // Artes das campanhas. Cada arquivo precisa da sua rota: o servidor não
    // expõe a pasta inteira, serve só o que está declarado aqui.
    if (req.method === 'GET' && p === '/arte-campanha.jpg') return serveFile(res, 'arte-campanha.jpg', 'image/jpeg');
    if (req.method === 'GET' && p === '/arte-natal.jpg') return serveFile(res, 'arte-natal.jpg', 'image/jpeg');
    // Páginas jurídicas (LGPD) — públicas
    if (req.method === 'GET' && (p === '/politica-de-privacidade' || p === '/politica.html'))
      return serveFile(res, 'politica.html', 'text/html');
    if (req.method === 'GET' && (p === '/regulamento' || p === '/regulamento.html'))
      return serveFile(res, 'regulamento.html', 'text/html');
    // Painel administrativo em endereço não-adivinhável (pode ser trocado por env
    // ADMIN_PATH sem novo deploy de código). O antigo /admin devolve 404, como se
    // não existisse painel nenhum.
    const ADMIN_PATH = process.env.ADMIN_PATH || '/gestao-8k42vx';
    if (req.method === 'GET' && p === ADMIN_PATH) return serveFile(res, 'admin.html', 'text/html');
    if (req.method === 'GET' && p === ADMIN_PATH + '.js') return serveFile(res, 'admin.js', 'application/javascript');
    // Terminal do balcão de retirada — endereço próprio, para a equipe deixar
    // aberto no tablet durante o expediente sem expor o painel de gestão.
    const BALCAO_PATH = process.env.BALCAO_PATH || '/retirada-n7p2';
    if (req.method === 'GET' && p === BALCAO_PATH) return serveFile(res, 'balcao.html', 'text/html');
    if (req.method === 'GET' && p === BALCAO_PATH + '.js') return serveFile(res, 'balcao.js', 'application/javascript');

    // -------- API pública --------
    if (req.method === 'GET' && p === '/api/v1/campanha') {
      const c = await store.getCampanha(null, CAMPANHA.id);
      const base = { id: c.id, nome: c.nome, modalidade: c.modalidade,
        dataInicio: c.dataInicio, dataFim: c.dataFim, status: c.status };
      if (c.modalidade === 'COMPRE_GANHE') {
        return send(res, 200, { ...base,
          valorMinimo: core.fromCents(c.valorMinimoCents),
          brinde: c.brindeDescricao,
          dataFimRetirada: c.dataFimRetirada,
          limitePorCpf: c.limitePorCpf,
          retirada: CAMPANHA.retirada || null,
          estoque: await store.contarBrindes(c.id),
        });
      }
      return send(res, 200, { ...base, valorUnidade: c.valorUnidade, qtdPremios: c.qtdPremios,
        autorizada: !!c.numCertificadoSPA, certificadoSPA: c.numCertificadoSPA });
    }

    // Estoque ao vivo: é o que sustenta a cláusula de "não constitui reserva".
    // O cliente consulta ANTES de comprar, em vez de descobrir no balcão.
    if (req.method === 'GET' && p === '/api/v1/estoque') {
      return send(res, 200, await store.contarBrindes(CAMPANHA.id));
    }

    // Relação pública das operações participantes (Cláusula 5 revisada).
    if (req.method === 'GET' && p === '/api/v1/lojas') {
      const c = await store.getCampanha(null, CAMPANHA.id);
      const vistas = new Set();
      const lojas = [];
      for (const l of c.lojas) {
        const nome = l.nome || l.razaoSocial || l.cnpj;
        if (vistas.has(nome)) continue;   // duas filiais, um nome só para o público
        vistas.add(nome);
        lojas.push({ nome, razaoSocial: l.razaoSocial });
      }
      return send(res, 200, { total: lojas.length, lojas });
    }

    if (req.method === 'POST' && p === '/api/v1/participantes') {
      const dados = await body(req);
      return send(res, 201, await svc.cadastrarParticipante(dados, ip, ua));
    }

    if (req.method === 'POST' && p === '/api/v1/notas') {
      const dados = await body(req);
      if (!dados.participanteId) throw pub('E-VAL', 'participanteId obrigatório.');
      const nota = await svc.enviarNota(dados.participanteId, dados, ip, ua);
      // Aviso ao time por e-mail (não bloqueia a resposta ao participante)
      store.q("SELECT count(*)::int AS n FROM nota_fiscal WHERE status='EM_ANALISE'")
        .then(r => email.avisarNotaPendente(r.rows[0].n)).catch(() => {});
      return send(res, 201, nota);
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
      const c = await store.getCampanha(null, CAMPANHA.id);

      // Só as notas DESTA campanha: quem participou das bicicletas não pode
      // ver aquele acumulado contando para o Natal.
      const notas = await store.notasDoParticipante(null, id, null, c.id);
      const notasPublicas = notas.map(n => ({ ...n,
        valorTotal: core.fromCents(n.valorTotalCents),
        valorElegivel: core.fromCents(n.valorElegivelCents) }));

      if (c.modalidade === 'COMPRE_GANHE') {
        const V = notas.filter(n => n.status === 'APROVADA')
          .reduce((s, n) => s + n.valorElegivelCents, 0);
        const direito = await store.getDireito(null, c.id, id);
        return send(res, 200, {
          modalidade: 'COMPRE_GANHE',
          participante: { id: part.id, nome: part.nome, cpf: svc.mascararCpf(part.cpf) },
          valorElegivel: core.fromCents(V),
          minimo: core.fromCents(c.valorMinimoCents),
          faltam: core.fromCents(Math.max(0, c.valorMinimoCents - V)),
          progresso: Math.min(100, Math.round((V / c.valorMinimoCents) * 100)),
          direito: svc.publicoDireito(direito, c),
          brinde: c.brindeDescricao,
          retirada: CAMPANHA.retirada || null,
          dataFimRetirada: c.dataFimRetirada,
          estoque: await store.contarBrindes(c.id),
          notas: notasPublicas,
        });
      }

      const nums = await store.numerosDoParticipante(null, id, 'ATIVO');
      return send(res, 200, {
        modalidade: 'SORTEIO',
        participante: svc.publicoParticipante(part),
        notas: notasPublicas,
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

    // -------- API do balcão de retirada (protegida) --------
    // Perfil BALCAO só enxerga estas rotas: consultar um CPF e registrar a
    // entrega. Não modera notas, não exporta lista, não acessa a auditoria —
    // é um terminal de atendimento, operado no piso durante o expediente.
    if (p.startsWith('/api/v1/balcao/')) {
      const s = auth(req, url);
      if (!s) return send(res, 401, { erro: 'E-AUTH-02', mensagem: 'Não autenticado.' });
      if (!['ADMIN', 'BALCAO'].includes(s.perfil))
        return send(res, 403, { erro: 'E-AUTH-05', mensagem: 'Perfil sem acesso ao balcão.' });

      if (req.method === 'POST' && p === '/api/v1/balcao/consultar') {
        const { cpf } = await body(req);
        return send(res, 200, await svc.consultarCpf(cpf));
      }
      if (req.method === 'POST' && p === '/api/v1/balcao/entregar') {
        const d = await body(req);
        return send(res, 200, await svc.entregarBrinde({
          direitoId: d.direitoId, atendente: s.usuario,
          documentoConferido: d.documentoConferido, observacao: d.observacao,
        }, ip));
      }
      if (req.method === 'GET' && p === '/api/v1/balcao/estoque') {
        return send(res, 200, await store.contarBrindes(CAMPANHA.id));
      }
      if (req.method === 'GET' && p === '/api/v1/balcao/fila') {
        const lista = await store.listarDireitos(CAMPANHA.id, 'QUALIFICADO');
        return send(res, 200, lista.map(d => ({
          id: d.id, nome: d.nome, cpf: svc.mascararCpf(d.cpf),
          valorApurado: core.fromCents(d.valorApuradoCents), qualificadoEm: d.qualificadoEm,
        })));
      }
      // Foto da nota, para a conferência no balcão.
      if (req.method === 'GET' && p.match(/^\/api\/v1\/balcao\/notas\/[^/]+\/foto$/)) {
        const f = await store.getFoto(p.split('/')[5]);
        if (!f) return send(res, 404, { erro: 'E-404', mensagem: 'Foto não encontrada.' });
        res.writeHead(200, { 'Content-Type': f.mime, 'Cache-Control': 'private, max-age=300' });
        return res.end(f.bytes);
      }
      return send(res, 404, { erro: 'E-404', mensagem: 'Rota não encontrada.' });
    }

    // -------- API admin (protegida) --------
    if (p.startsWith('/api/v1/admin/')) {
      const s = auth(req, url);
      if (!s) return send(res, 401, { erro: 'E-AUTH-02', mensagem: 'Não autenticado.' });
      if (s.perfil === 'BALCAO')
        return send(res, 403, { erro: 'E-AUTH-05', mensagem: 'Perfil de balcão não acessa a gestão.' });
      const usuario = s.usuario;

      if (req.method === 'GET' && p === '/api/v1/admin/brindes') {
        const status = url.searchParams.get('status') || null;
        const lista = await store.listarDireitos(CAMPANHA.id, status);
        return send(res, 200, {
          estoque: await store.contarBrindes(CAMPANHA.id),
          direitos: lista.map(d => ({
            id: d.id, nome: d.nome, cpf: svc.mascararCpf(d.cpf),
            telefone: d.telefone, email: d.email, status: d.status,
            valorApurado: core.fromCents(d.valorApuradoCents),
            qualificadoEm: d.qualificadoEm, retiradoEm: d.retiradoEm,
            atendente: d.atendente, observacao: d.observacao,
          })),
        });
      }

      // Relatório de entregas para a prestação de contas da campanha de Natal.
      if (req.method === 'GET' && p === '/api/v1/admin/export/brindes.csv') {
        const lista = await store.listarDireitos(CAMPANHA.id, null);
        const linhas = ['cpf;nome;telefone;email;status;valor_apurado;qualificado_em;retirado_em;atendente;documento_conferido'];
        for (const d of lista) {
          linhas.push([
            String(d.cpf || '').replace(/\D/g, ''), d.nome, d.telefone || '', d.email || '',
            d.status, core.fromCents(d.valorApuradoCents),
            dataHoraSCPC(d.qualificadoEm), d.retiradoEm ? dataHoraSCPC(d.retiradoEm) : '',
            d.atendente || '', d.documentoConferido || '',
          ].map(v => String(v).replace(/;/g, ',')).join(';'));
        }
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename=brindes_natal_2026.csv' });
        return res.end(linhas.join('\r\n'));
      }

      if (req.method === 'GET' && p === '/api/v1/admin/dashboard') {
        const campanha = await store.getCampanha(null, CAMPANHA.id);
        const todas = await store.listarNotas(null);
        const notas = todas.filter(n => n.campanhaId === campanha.id);
        const porStatus = notas.reduce((a, n) => (a[n.status] = (a[n.status] || 0) + 1, a), {});
        const comum = {
          modalidade: campanha.modalidade,
          campanha: campanha.nome,
          notas: notas.length, notasPorStatus: porStatus,
          valorValidado: core.fromCents(notas.filter(n => n.status === 'APROVADA').reduce((t, n) => t + n.valorElegivelCents, 0)),
          participantes: (await store.listarParticipantes(null)).length,
        };
        if (campanha.modalidade === 'COMPRE_GANHE') {
          const e = await store.contarBrindes(campanha.id);
          return send(res, 200, { ...comum, estoque: e, brinde: campanha.brindeDescricao,
            valorMinimo: core.fromCents(campanha.valorMinimoCents) });
        }
        return send(res, 200, { ...comum,
          numerosAtivos: await store.contarNumeros(null, 'ATIVO'),
          numerosInutilizados: await store.contarNumeros(null, 'INUTILIZADO'),
          autorizadaSPA: !!campanha.numCertificadoSPA,
        });
      }
      if (req.method === 'GET' && p === '/api/v1/admin/notas') {
        const notas = await store.listarNotas(null);
        // Nome de quem enviou, para a moderação não precisar cruzar IDs à mão.
        const parts = await store.listarParticipantes(null);
        const quem = new Map(parts.map(pt => [pt.id, { nome: pt.nome, cpf: svc.mascararCpf(pt.cpf) }]));
        return send(res, 200, notas.map(n => ({
          ...n, valorTotal: core.fromCents(n.valorTotalCents),
          valorElegivel: core.fromCents(n.valorElegivelCents), fotoUrl: `/api/v1/admin/notas/${n.id}/foto`,
          participanteNome: (quem.get(n.participanteId) || {}).nome || '—',
          participanteCpf: (quem.get(n.participanteId) || {}).cpf || '',
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
    // HTML/JS nunca ficam em cache: com a campanha no ar, um celular preso numa
    // versão antiga da página significa bug "fantasma" que já foi corrigido no
    // servidor. Imagens podem ser guardadas (mudam raramente e pesam mais).
    const cache = (type === 'text/html' || type === 'application/javascript')
      ? 'no-store' : 'public, max-age=86400';
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': cache });
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
  // Correções pontuais (idempotentes). Nunca derrubam o boot.
  try { await require('./migracoes')(store); }
  catch (e) { console.error('Migração pontual falhou (sistema sobe mesmo assim):', e.message); }
  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  ╔══════════════════════════════════════════════════════╗');
    console.log('  ║   Aldeia Premia · Shopping Aldeia da Serra            ║');
    console.log('  ╚══════════════════════════════════════════════════════╝\n');
    console.log(`  Portal:   http://localhost:${PORT}`);
    console.log(`  Painel:   http://localhost:${PORT}${process.env.ADMIN_PATH || '/gestao-8k42vx'}`);
    console.log(`  Balcão:   http://localhost:${PORT}${process.env.BALCAO_PATH || '/retirada-n7p2'}`);
    console.log(`  Banco:    conectado`);
    console.log(`  Campanha: ${CAMPANHA.nome} (${CAMPANHA.modalidade || 'SORTEIO'})`);
    console.log(`  Período:  ${CAMPANHA.dataInicio} a ${CAMPANHA.dataFim}`);
    if (CAMPANHA.modalidade === 'COMPRE_GANHE') {
      console.log(`  Brinde:   ${CAMPANHA.brindeDescricao} — ${CAMPANHA.estoqueTotal} unidades`);
      console.log(`  Mínimo:   R$ ${(CAMPANHA.valorMinimoCents / 100).toFixed(2)} · retirada até ${CAMPANHA.dataFimRetirada}`);
      console.log(`  SPA/MF:   dispensada (compre e ganhe, sem sorteio ou vale-brinde)\n`);
    } else {
      console.log(`  SPA/MF:   ${CAMPANHA.numCertificadoSPA || 'certificado ainda não informado (modo pré-autorização)'}\n`);
    }
  });
}

if (require.main === module) {
  subir().catch(e => { console.error('Falha ao subir:', e.message); process.exit(1); });
}
module.exports = { server, subir };
