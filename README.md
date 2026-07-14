# Aldeia Premia — Plataforma de Campanhas Promocionais

**Shopping Aldeia da Serra** · Campanha "Compre e Concorra" (2 bicicletas elétricas, 2 ganhadores, 1 Número da Sorte a cada R$ 500,00 em compras).

Cadastro do participante, leitura do QR/chave da NFC-e, moderação de notas, emissão de Números da Sorte únicos e auditáveis, apuração vinculada à Loteria Federal, trilha de auditoria verificável e exportação da lista no layout do SCPC.

---

## ⚖️ Situação regulatória

Este sistema opera uma promoção comercial sujeita à Lei 5.768/1971 e ao Decreto 70.951/1972, cuja realização **depende de Certificado de Autorização emitido pela SPA/MF** (protocolo via SCPC).

Enquanto a variável `CERTIFICADO_SPA` não estiver preenchida, o sistema roda em **modo pré-autorização**: opera normalmente, mas registra que a campanha ainda não tem certificado. Preencher assim que a autorização sair.

Os parâmetros da campanha (datas, valor da unidade, lojas, modalidade) devem espelhar **o regulamento aprovado**, não o contrário. Ver `campanha.config.js` e a Especificação Funcional.

---

## Como rodar

**Requer:** Node.js 18+ e um PostgreSQL. O sistema **não sobe sem banco** — isso é proposital: os cadastros dos participantes não podem depender de disco efêmero.

```bash
npm install

export DATABASE_URL="postgresql://usuario:senha@host:5432/banco"
export APP_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
export ADMIN_SENHA="uma senha forte"

node server.js     # http://localhost:3000
```

O schema é criado e migrado sozinho no boot (`schema.sql`). Se o banco falhar, o processo morre em vez de atender participante com banco meio configurado.

### Variáveis de ambiente

| Variável | Obrigatória | Para quê |
|---|---|---|
| `DATABASE_URL` | sim | Conexão com o PostgreSQL. |
| `APP_KEY` | sim | 32 bytes (64 hex) — cifra o CPF em repouso (AES-256-GCM). **Se for perdida, os CPFs se tornam ilegíveis.** |
| `ADMIN_SENHA` | sim (1º boot) | Senha do admin inicial. Nunca fica no código. |
| `ADMIN_EMAIL` | não | E-mail do admin inicial. |
| `CERTIFICADO_SPA` | não | Nº do Certificado de Autorização, quando a SPA/MF emitir. |
| `TZ` | recomendada | `America/Sao_Paulo`. |

### Testes

```bash
node test.js              # 20 testes — regras puras (cálculo, CPF, chave NFC-e, apuração)
node test-integracao.js   # 24 testes — precisa de DATABASE_URL apontando para um banco DESCARTÁVEL
```

O `test-integracao.js` **apaga o schema inteiro** antes de rodar. Nunca aponte para o banco de produção.

Para um Postgres local descartável: `node pg-local.js iniciar`.

---

## Arquitetura

| Arquivo | Responsabilidade |
|---|---|
| `core.js` | Regras puras: cálculo de números, validação de CPF, parsing da chave NFC-e, hash, apuração. Sem I/O — testável isoladamente. |
| `store-pg.js` | **Única** camada de persistência. Transações, cifragem do CPF, cadeia de hash, auditoria append-only. |
| `service.js` | Serviços de domínio: cadastro, notas, recálculo/inutilização de números, sorteio. |
| `server.js` | Servidor HTTP (Node puro), API REST, rate limit, sessões, exportação CSV/SCPC. |
| `schema.sql` | Schema do PostgreSQL, com as travas de integridade. |
| `campanha.config.js` | Parâmetros da campanha, semeados no 1º boot. |
| `index.html` / `app.js` | Portal do participante. |
| `admin.html` / `admin.js` | Painel administrativo (rota `/admin`, separada do portal). |

Não há armazenamento alternativo em arquivo. Um segundo caminho para emitir Números da Sorte significaria duas lógicas para o auditor conferir, e o risco de cair em silêncio num armazenamento volátil.

---

## O que sustenta a auditoria

**Unicidade do Número da Sorte.** Emissão dentro de uma transação com `SELECT ... FOR UPDATE` na campanha, mais índice `UNIQUE (campanha_id, serie, numero)` como segunda barreira. Testado com 20 transações simultâneas emitindo 100 números: todos distintos.

**Cadeia de hash.** Cada número guarda o hash do anterior, na ordem real de emissão (coluna `seq`, monotônica — `id` é aleatório e `emitido_em` colide no mesmo milissegundo). A verificação confere o elo **e** recalcula o hash a partir dos dados gravados: trocar o número contemplado sem mexer nos hashes também é detectado.

**Trilha append-only.** Triggers no banco recusam `UPDATE`/`DELETE` na auditoria e `DELETE` em Números da Sorte — números só mudam de status para `INUTILIZADO`/`CANCELADO`, nunca somem. A gravação da trilha é serializada por lock consultivo; sem ele, requisições simultâneas bifurcariam a cadeia.

**Snapshot da apuração.** O sorteio registra o SHA-256 de todos os números ativos no instante da apuração, travando a campanha durante a operação.

**Limite honesto:** quem tiver acesso de escrita ao banco *e* conhecer o algoritmo ainda pode recalcular a cadeia inteira. O que sustenta a prova nesse cenário é o cruzamento entre a cadeia, o `snapshot_hash` da apuração e a trilha de auditoria — não a cadeia sozinha.

**Dados pessoais (LGPD).** CPF cifrado em repouso (AES-256-GCM) com hash determinístico separado para busca; consentimento registrado por finalidade, com versão, IP e dispositivo; marketing consentido em separado, nunca como condição para participar. Senhas em scrypt. As fotos das notas ficam no banco, com SHA-256, e não em disco efêmero.

---

## Pendências conhecidas

- **MFA (TOTP) no painel administrativo** — a coluna existe no schema, o fluxo não está implementado.
- **Elegibilidade da promotora** e demais pontos em aberto: ver o Dossiê enviado ao jurídico.
- **Volume das fotos** — a até 6 MB por nota, o plano atual do banco (1 GB) comporta a ordem de algumas centenas de notas. Monitorar e ampliar se necessário.
