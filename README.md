# Sistema "Compre e Concorra" — Shopping Aldeia da Serra (Protótipo)

Protótipo **funcional** do sistema de campanha promocional (2 bicicletas elétricas, 2 ganhadores,
1 Número da Sorte a cada R$ 400,00). Implementa cadastro, upload/moderação de notas, **geração de
Números da Sorte únicos e auditáveis** (com hash encadeado), painel administrativo, apuração
vinculada à Loteria Federal e trilha de auditoria com verificação de integridade.

> ⚠️ **Protótipo para validação.** NÃO usar em produção sem: (1) revisão jurídica por advogado
> especializado em promoções comerciais; (2) autorização da SPA/MF via SCPC; (3) troca do
> armazenamento por PostgreSQL, hashing de senha com argon2/bcrypt, HTTPS, MFA e WAF.
> Ver a **Especificação Funcional** completa (documento Markdown que acompanha este projeto).

## Como rodar

Requer apenas **Node.js 18+** (nenhuma dependência a instalar).

```bash
cd sistema
node server.js
# abra http://localhost:3000
```

Rodar os testes de regras de negócio:

```bash
node test.js
```

## Credenciais de demonstração

- **Admin:** `admin@aldeia.com.br` / `admin123`
- **Participante:** cadastre-se na aba "Cadastro" (use um CPF válido, ex.: 529.982.247-25) e use o
  ID gerado (ex.: `P-1`) na aba "Minha Área".

## Fluxo de demonstração

1. **Cadastro** → aceite regulamento + privacidade → recebe um `ID`.
2. **Minha Área** → entre com o ID → **envie uma nota** (ex.: R$ 1.250,00).
3. **Painel Admin** → login → **Moderação de Notas** → **Aprovar** → o sistema gera automaticamente
   3 Números da Sorte (1250 ÷ 400 = 3, sobra R$ 50,00 de saldo).
4. Volte à **Minha Área** → veja seus números e o saldo remanescente.
5. **Painel Admin → Sorteio** → informe os 5 prêmios da Loteria Federal → **Apurar** → o sistema
   calcula o número contemplado e localiza o(s) ganhador(es) (com regra de aproximação/suplência).
6. **Auditoria** → "Verificar cadeia" confirma a integridade dos registros.

## Arquitetura dos arquivos

| Arquivo | Responsabilidade |
|---|---|
| `core.js` | Regras de negócio **puras** (cálculo de números, CPF, hash, apuração). Testável isoladamente. |
| `db.js` | Persistência (JSON no protótipo) + **trilha de auditoria append-only** com hash encadeado. |
| `service.js` | Serviços de domínio: cadastro, notas, recálculo/inutilização de números, sorteio. |
| `server.js` | Servidor HTTP (Node puro), API REST, rate limit, sessões admin, exportação CSV. |
| `public/` | Portal do participante + painel administrativo (HTML/JS). |
| `test.js` | Testes dos critérios de aceitação (Seção 21 da especificação). |
| `data/db.json` | Base de dados do protótipo (recriada automaticamente se ausente). |

## Garantias implementadas (mapeadas à especificação)

- **Unicidade** dos números: alocação sequencial + verificação de colisão + histórico (Seção 6.3).
- **Auditabilidade**: cada número tem `hashIntegridade` encadeado; auditoria append-only verificável (Seções 6.6/15).
- **Cálculo correto** (piso R$400) e **saldo remanescente** acumulado (Seções 5.4/6.1) — validado em `test.js`.
- **Recálculo/inutilização** ao cancelar nota (Seção 6.7/6.8).
- **Apuração** com número contemplado configurável e **regra de aproximação** (Seção 7).
- **Segurança básica**: rate limit, sessão por token, CPF mascarado, senha em hash.

## Pontos que dependem de validação jurídica / SPA (⚖️)

- Modalidade exata, nº de dígitos e séries do Número da Sorte.
- **Regra de composição** do número contemplado a partir da Loteria Federal.
- Regra de aproximação e de suplência.
- Lista de produtos vedados e de lojas/CNPJs participantes.
- Vedação de participação (funcionários, lojistas, familiares).
- Prazos de prescrição do prêmio e de prestação de contas.

Estes pontos estão **parametrizados** em `db.js` (`campanha`) e devem refletir o **regulamento aprovado**.
