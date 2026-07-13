# Publicar o sistema online (link fixo e gratuito)

Objetivo: colocar o sistema na internet para o time acessar por um link fixo (ex.:
`https://compre-e-concorra-aldeia.onrender.com`), **sem depender do seu computador ligado**.

Vamos usar dois serviços gratuitos: **GitHub** (guarda os arquivos) + **Render** (roda o sistema).
Leva ~15 minutos e não precisa saber programar. Se travar em algum passo, me chame que eu te acompanho.

---

## Parte 1 — Subir os arquivos no GitHub

1. Crie uma conta grátis em **https://github.com** (se ainda não tiver).
2. Clique no **+** (canto superior direito) → **New repository**.
3. Em *Repository name*, escreva `compre-e-concorra-aldeia`. Deixe **Public**. Clique **Create repository**.
4. Na página do repositório novo, clique em **uploading an existing file** (link no meio da tela).
5. **Descompacte o zip** que te enviei e arraste para lá **todo o conteúdo da pasta `sistema`**
   (os arquivos `server.js`, `package.json`, a pasta `public`, etc.) — e **não** a pasta `sistema` em si.
   > Importante: o arquivo `server.js` precisa ficar na **raiz** do repositório.
6. Clique em **Commit changes**.

## Parte 2 — Publicar no Render

1. Crie uma conta grátis em **https://render.com** (dá para entrar com o próprio GitHub — mais rápido).
2. No painel, clique **New +** → **Web Service**.
3. Conecte sua conta do GitHub e **selecione o repositório** `compre-e-concorra-aldeia`.
4. Confira/preencha:
   - **Language / Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type / Plan:** **Free**
5. Clique **Create Web Service** e aguarde alguns minutos (vai aparecer "Live" em verde).
6. No topo da página vai estar o **link público** (ex.: `https://compre-e-concorra-aldeia.onrender.com`).
   **Esse é o link que você envia para o time.**
   - Site do cliente: esse link.
   - Painel do admin: o mesmo link + `/admin` (ex.: `.../admin`).

Pronto! Sempre que você alterar algo no GitHub, o Render republica sozinho.

---

## O que esperar do plano gratuito (importante)
- **Hiberna após ~15 min sem uso:** a primeira visita depois disso demora ~30 segundos para "acordar". Normal no plano free.
- **Os dados são temporários:** cadastros, notas e fotos podem ser zerados quando o serviço reinicia ou é republicado. Ótimo para **testar**, não para a campanha real.
- **Segurança do teste — troque a senha do admin:** no Render, abra o serviço → aba **Environment** →
  **Add Environment Variable** → crie `ADMIN_SENHA` com a senha que você quiser (e, se quiser, `ADMIN_EMAIL`).
  Salve. O painel `/admin` passa a usar essa senha em vez da de demonstração.

## Para a campanha de verdade (quando aprovar)
Antes de ir ao público, além da revisão jurídica e da autorização da SPA/MF, o sistema precisa de:
banco de dados permanente (PostgreSQL), armazenamento fixo das fotos, HTTPS com domínio próprio,
senha forte + MFA no admin e backups. Tudo isso está descrito na Especificação Funcional. Me avise
que eu preparo essa versão de produção.

---

### Alternativa ainda mais simples (sem GitHub): Replit
Se preferir não mexer com GitHub: crie conta em **https://replit.com**, clique **Create App** →
**Import** → envie o zip, e depois **Run**. O Replit gera um link público enquanto o app está rodando.
É mais rápido de começar, mas o link fica ativo principalmente enquanto a aba está aberta — por isso,
para algo mais estável, o Render (acima) é a melhor escolha gratuita.
