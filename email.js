'use strict';
/**
 * Aviso por e-mail ao time quando chega nota fiscal para moderar.
 *
 * Desligado por padrão: só ativa quando as variáveis SMTP_* existirem no ambiente.
 * Sem elas, não faz nada e não derruba nada — o envio de nota do participante
 * NUNCA pode falhar por causa de um aviso interno.
 *
 * Variáveis de ambiente:
 *   SMTP_HOST   — servidor de envio (ex.: smtp.gmail.com)
 *   SMTP_PORT   — porta (587 padrão; 465 usa TLS direto)
 *   SMTP_USER   — a conta que envia (ex.: marketing@shoppingaldeiadaserra.com.br)
 *   SMTP_SENHA  — senha de app da conta (definida no painel do Render)
 *   NOTIFY_EMAIL — quem recebe (padrão: marketing@shoppingaldeiadaserra.com.br)
 */
const nodemailer = require('nodemailer');

// No máximo 1 aviso a cada 30 min: num sábado de campanha podem entrar dezenas
// de notas por hora, e uma caixa lotada de avisos é pior do que nenhum.
const INTERVALO_MIN = 30;
let ultimoEnvio = 0;

const configurado = () =>
  !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_SENHA);

async function avisarNotaPendente(pendentes) {
  if (!configurado()) return;
  const agora = Date.now();
  if (agora - ultimoEnvio < INTERVALO_MIN * 60000) return;
  ultimoEnvio = agora;
  try {
    const porta = parseInt(process.env.SMTP_PORT || '587', 10);
    const t = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: porta,
      secure: porta === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_SENHA },
    });
    const destino = process.env.NOTIFY_EMAIL || 'marketing@shoppingaldeiadaserra.com.br';
    await t.sendMail({
      from: `"Aldeia Premia" <${process.env.SMTP_USER}>`,
      to: destino,
      subject: `Aldeia Premia: ${pendentes} nota${pendentes > 1 ? 's' : ''} aguardando moderação`,
      text:
        `Há ${pendentes} nota${pendentes > 1 ? 's' : ''} fiscal${pendentes > 1 ? 'is' : ''} ` +
        `aguardando análise no painel.\n\n` +
        `Moderar agora: https://aldeiapremia.com.br/admin\n\n` +
        `(Aviso automático da plataforma — enviado no máximo 1 vez a cada ${INTERVALO_MIN} minutos.)`,
    });
  } catch (e) {
    // Aviso é conveniência; o cadastro da nota já foi gravado com sucesso.
    console.error('Aviso por e-mail falhou:', e.message);
  }
}

module.exports = { avisarNotaPendente, configurado };
