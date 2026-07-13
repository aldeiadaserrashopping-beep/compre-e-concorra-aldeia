# Comece aqui — Compre e Concorra (Shopping Aldeia da Serra)

Guia rápido para rodar o sistema e testar com o time. Sem termos técnicos.

## 1. Uma vez só: instalar o Node.js
O sistema precisa do **Node.js** (é grátis e leva 2 minutos).
- Acesse **https://nodejs.org**, baixe a versão **LTS** e instale (avançar → avançar → concluir).
- Precisa fazer isso **só no computador que vai rodar o sistema** (o seu). O time não precisa instalar nada.

## 2. Abrir o sistema
Na pasta `sistema`:
- **Mac:** dê duplo clique em **`Iniciar-MAC.command`**
- **Windows:** dê duplo clique em **`Iniciar-WINDOWS.bat`**

Vai abrir uma janela preta (é normal — é o "motor" do sistema) e, em seguida, o navegador em **http://localhost:3000**.

> Se no Mac aparecer um aviso de segurança na primeira vez: clique com o botão direito no arquivo → **Abrir** → **Abrir**.

## 3. Como o time acessa (mesma rede Wi-Fi)
Quando o sistema abre, a janela preta mostra dois endereços, por exemplo:

```
Neste computador:   http://localhost:3000
Para o time:        http://192.168.0.15:3000
```

Passe o endereço **"Para o time"** para o pessoal digitar no navegador do próprio celular/notebook (todos precisam estar na **mesma rede Wi-Fi** que o seu computador). Assim vocês testam juntos, ao vivo.

## 4. Como voltar / reabrir depois
- **Voltar dentro do site:** use o menu no topo — **Participar** e **Minha Área**. Quem já se cadastrou entra na "Minha Área" só com o **CPF**.
- **Reabrir o sistema outro dia:** é só dar duplo clique no atalho de novo (passo 2). Os cadastros e notas ficam salvos.
- **Fechar:** feche a janela preta (ou aperte `Ctrl + C` nela).

## 4b. Enviar um LINK para o time testar de longe (fora da sua rede)
Tem três caminhos, do mais simples ao mais definitivo:

1. **Mesma sala / mesmo Wi-Fi (mais fácil):** use o endereço "Para o time" do passo 3. Zero configuração.

2. **Link público temporário (para um teste rápido à distância):**
   - Deixe o sistema rodando (passo 2).
   - Em outra janela, dê duplo clique em **`Compartilhar-Link-MAC.command`** (Mac) ou **`Compartilhar-Link-WINDOWS.bat`** (Windows).
   - Vai aparecer um endereço `https://...loca.lt` — **esse é o link que você envia** no grupo.
   - Observações: o **seu computador precisa ficar ligado e com o sistema aberto**; na primeira visita o navegador pode mostrar uma página de aviso — é só clicar em **continuar**. O link muda cada vez que você gera um novo.

3. **Link fixo, sempre no ar (para valer):** hospedar o sistema na internet (ex.: Render, Railway, um servidor). Aí o link funciona sempre, sem depender do seu computador. **Me avise que eu preparo essa publicação para você** — é o passo recomendado quando for testar com mais gente ou seguir para a campanha real.

## 5. Roteiro sugerido para a demonstração
1. Abra **http://localhost:3000** → faça um **cadastro** (use um CPF válido).
2. O sistema já te leva para a **Minha Área**.
3. Em **Enviar nota**: cole uma chave de NF-e (ou digite os campos), informe o valor (ex.: **R$ 1.250**) e anexe uma **foto** qualquer como comprovante.
4. Abra o **painel do admin** em **http://localhost:3000/admin**
   (login: `admin@aldeia.com.br` / senha: `admin123`).
5. Em **Moderação de notas**, clique **Aprovar** → o sistema gera os **números da sorte** (1250 ÷ 400 = **3 números**, sobra R$ 50).
6. Volte à **Minha Área** e veja os números e o saldo.
7. No admin, em **Sorteio**, informe os 5 prêmios da Loteria Federal e clique **Executar apuração** para ver a localização do ganhador.
8. Em **Auditoria**, clique **Verificar integridade** para mostrar que tudo é rastreável.

## Observações importantes
- O **painel do admin fica em endereço separado** (`/admin`) e **o cliente não o vê**. Mas cliente e admin usam **o mesmo banco de dados** — os dados continuam todos cruzados (CPF → notas → números → ganhadores) e a **auditoria registra tudo**.
- Este é um **protótipo para demonstração e validação**. Antes de usar de verdade com o público, é preciso: revisão do **advogado**, **autorização da SPA/MF** (SCPC), e ajustes de produção (senha forte/MFA, HTTPS, hospedagem, banco PostgreSQL).
- A leitura automática do **QR pela câmera** funciona melhor no **celular**. No computador, dá para **colar** a chave/QR no campo indicado.
