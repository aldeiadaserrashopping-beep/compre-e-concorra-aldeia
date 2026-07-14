-- =====================================================================
-- Aldeia Premia — schema de PRODUÇÃO (PostgreSQL)
-- Campanha "Compre e Concorra" — Shopping Aldeia da Serra
-- Referência: Especificação Funcional, Seção 10 (Banco de Dados)
-- =====================================================================

-- ------------------------------------------------------------- sentinela
-- Guarda um texto conhecido cifrado com a APP_KEY em uso. No boot, o sistema
-- tenta decifrá-lo: se falhar, a chave mudou e TODOS os CPFs gravados estão
-- ilegíveis. Melhor descobrir no deploy, com a versão antiga ainda no ar, do
-- que na véspera da apuração, quando a lista do SCPC não puder mais ser gerada.
CREATE TABLE IF NOT EXISTS sentinela_chave (
  id        TEXT PRIMARY KEY,
  valor     TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- campanha
CREATE TABLE IF NOT EXISTS campanha (
  id                  TEXT PRIMARY KEY,
  nome                TEXT        NOT NULL,
  valor_unidade       NUMERIC(10,2) NOT NULL,      -- R$ 500,00 => 1 Número da Sorte
  qtd_premios         INT         NOT NULL,
  qtd_ganhadores      INT         NOT NULL,
  data_inicio         DATE        NOT NULL,
  data_fim            DATE        NOT NULL,
  data_apuracao       DATE,
  num_certificado_spa TEXT,                        -- trava de go-live: NULL = não autorizada
  acumula_saldo       BOOLEAN     NOT NULL DEFAULT TRUE,
  serie_atual         INT         NOT NULL DEFAULT 1,
  proximo_numero      INT         NOT NULL DEFAULT 0,
  tamanho_serie       INT         NOT NULL DEFAULT 100000,
  digitos             INT         NOT NULL DEFAULT 5,
  status              TEXT        NOT NULL DEFAULT 'ATIVA',
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loja_participante (
  campanha_id TEXT NOT NULL REFERENCES campanha(id) ON DELETE CASCADE,
  cnpj        TEXT NOT NULL,
  nome        TEXT,
  razao_social TEXT,
  PRIMARY KEY (campanha_id, cnpj)
);

CREATE TABLE IF NOT EXISTS denylist_cpf (
  campanha_id TEXT NOT NULL REFERENCES campanha(id) ON DELETE CASCADE,
  cpf_hash    TEXT NOT NULL,
  motivo      TEXT,
  PRIMARY KEY (campanha_id, cpf_hash)
);

-- ----------------------------------------------------------- participante
-- CPF guardado com hash para busca + valor cifrado em repouso (LGPD).
CREATE TABLE IF NOT EXISTS participante (
  id                       TEXT PRIMARY KEY,
  cpf_hash                 TEXT        NOT NULL UNIQUE,   -- RN-16: um CPF = uma conta
  cpf_enc                  TEXT        NOT NULL,          -- CPF cifrado (AES-256-GCM)
  nome                     TEXT        NOT NULL,
  data_nascimento          DATE        NOT NULL,
  telefone                 TEXT,
  email                    TEXT,
  cidade                   TEXT,
  uf                       TEXT,
  senha_hash               TEXT,                          -- scrypt
  valor_elegivel_cents     BIGINT      NOT NULL DEFAULT 0,
  saldo_remanescente_cents BIGINT      NOT NULL DEFAULT 0,
  numeros_ativos           INT         NOT NULL DEFAULT 0,
  status                   TEXT        NOT NULL DEFAULT 'ATIVO',
  criado_em                TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prova de consentimento (LGPD + Marco Civil): IP, dispositivo, versão e data/hora.
CREATE TABLE IF NOT EXISTS consentimento (
  id              BIGSERIAL PRIMARY KEY,
  participante_id TEXT        NOT NULL REFERENCES participante(id) ON DELETE CASCADE,
  tipo            TEXT        NOT NULL,   -- regulamento | privacidade | marketing
  versao          TEXT        NOT NULL,
  aceito          BOOLEAN     NOT NULL,
  ip              TEXT,
  user_agent      TEXT,
  data_hora       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consent_part ON consentimento(participante_id);

-- ------------------------------------------------------------ nota fiscal
CREATE TABLE IF NOT EXISTS nota_fiscal (
  id                   TEXT PRIMARY KEY,
  campanha_id          TEXT        NOT NULL REFERENCES campanha(id),
  participante_id      TEXT        NOT NULL REFERENCES participante(id) ON DELETE CASCADE,
  chave_nfe            TEXT UNIQUE,                       -- RN-05: nota única em todo o sistema
  cnpj_emitente        TEXT,
  valor_total_cents    BIGINT      NOT NULL,
  valor_elegivel_cents BIGINT      NOT NULL,
  data_compra          DATE,
  ano_mes_nota         TEXT,
  origem               TEXT,                              -- QR | CHAVE | FOTO
  foto_url             TEXT,
  status               TEXT        NOT NULL DEFAULT 'EM_ANALISE',
  motivo_rejeicao      TEXT,
  analisado_por        TEXT,
  analisado_em         TIMESTAMPTZ,
  criado_em            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nota_part   ON nota_fiscal(participante_id);
CREATE INDEX IF NOT EXISTS idx_nota_status ON nota_fiscal(status);

-- A foto da nota é a evidência que sustenta a validação perante o auditor.
-- Fica no banco, e não em disco: o disco do serviço web é efêmero (some a cada
-- deploy/restart), o que apagaria a evidência no meio da campanha sem avisar.
CREATE TABLE IF NOT EXISTS nota_foto (
  nota_id    TEXT PRIMARY KEY REFERENCES nota_fiscal(id) ON DELETE CASCADE,
  mime       TEXT  NOT NULL,
  bytes      BYTEA NOT NULL,
  tamanho    INT   NOT NULL,
  sha256     TEXT  NOT NULL,           -- prova de que a imagem não foi trocada depois
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------- número da sorte
-- Garantia central de auditoria: UNIQUE impede fisicamente duplicidade.
CREATE TABLE IF NOT EXISTS numero_sorte (
  id               TEXT PRIMARY KEY,
  -- Ordem REAL da cadeia de hash. Não usar id (aleatório) nem emitido_em (colide no
  -- mesmo milissegundo) para encadear: só esta sequência é monotônica e confiável.
  seq              BIGSERIAL   NOT NULL UNIQUE,
  campanha_id      TEXT        NOT NULL REFERENCES campanha(id),
  serie            TEXT        NOT NULL,
  numero           TEXT        NOT NULL,
  participante_id  TEXT        NOT NULL REFERENCES participante(id) ON DELETE RESTRICT,
  nota_origem_id   TEXT REFERENCES nota_fiscal(id),
  status           TEXT        NOT NULL DEFAULT 'ATIVO',  -- ATIVO | INUTILIZADO | CANCELADO
  emitido_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  hash_anterior    TEXT        NOT NULL,
  hash_integridade TEXT        NOT NULL,
  CONSTRAINT uq_numero_por_campanha UNIQUE (campanha_id, serie, numero)
);
CREATE INDEX IF NOT EXISTS idx_num_part   ON numero_sorte(participante_id);
CREATE INDEX IF NOT EXISTS idx_num_status ON numero_sorte(status);

CREATE TABLE IF NOT EXISTS numero_sorte_historico (
  id             BIGSERIAL PRIMARY KEY,
  numero_id      TEXT        NOT NULL REFERENCES numero_sorte(id),
  status_anterior TEXT,
  status_novo    TEXT        NOT NULL,
  motivo         TEXT,
  usuario        TEXT,
  ip             TEXT,
  data_hora      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_numhist ON numero_sorte_historico(numero_id);

-- Números nunca são apagados: proíbe DELETE fisicamente (Seção 6.8 / 10.4).
CREATE OR REPLACE FUNCTION impede_delete_numero() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Números da Sorte não podem ser excluídos — use status INUTILIZADO/CANCELADO.';
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_numero_no_delete ON numero_sorte;
CREATE TRIGGER trg_numero_no_delete BEFORE DELETE ON numero_sorte
  FOR EACH ROW EXECUTE FUNCTION impede_delete_numero();

-- ------------------------------------------------------------- admin/RBAC
CREATE TABLE IF NOT EXISTS usuario (
  id          TEXT PRIMARY KEY,
  nome        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  senha_hash  TEXT NOT NULL,          -- scrypt (nunca texto puro)
  perfil      TEXT NOT NULL,          -- ADMIN | SUPERVISOR | OPERADOR | AUDITOR
  mfa_secret  TEXT,                   -- TOTP (base32)
  mfa_ativo   BOOLEAN NOT NULL DEFAULT FALSE,
  ativo       BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------- sorteio
CREATE TABLE IF NOT EXISTS sorteio (
  id                TEXT PRIMARY KEY,
  campanha_id       TEXT NOT NULL REFERENCES campanha(id),
  data_apuracao     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resultado_loteria JSONB NOT NULL,
  snapshot_hash     TEXT NOT NULL,
  executado_por     TEXT,
  executado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ganhador (
  id              TEXT PRIMARY KEY,
  sorteio_id      TEXT NOT NULL REFERENCES sorteio(id) ON DELETE CASCADE,
  premio_ordem    INT  NOT NULL,
  numero_alvo     TEXT,
  regra           TEXT,
  numero_id       TEXT REFERENCES numero_sorte(id),
  participante_id TEXT REFERENCES participante(id),
  tipo            TEXT DEFAULT 'TITULAR',
  status          TEXT NOT NULL,
  motivo          TEXT,
  data_hora       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_premio_por_sorteio UNIQUE (sorteio_id, premio_ordem)
);

-- ------------------------------------------------------------ auditoria
-- Append-only com hash encadeado (Seção 15). Sem UPDATE/DELETE.
CREATE TABLE IF NOT EXISTS auditoria (
  id             BIGSERIAL PRIMARY KEY,
  entidade       TEXT NOT NULL,
  entidade_id    TEXT,
  acao           TEXT NOT NULL,
  usuario        TEXT,
  ip             TEXT,
  user_agent     TEXT,
  valor_anterior JSONB,
  valor_novo     JSONB,
  data_hora      TIMESTAMPTZ NOT NULL DEFAULT now(),
  hash_anterior  TEXT NOT NULL,
  hash           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aud_entidade ON auditoria(entidade, entidade_id);

CREATE OR REPLACE FUNCTION auditoria_imutavel() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'A trilha de auditoria é append-only: alteração/exclusão não permitida.';
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_auditoria_imutavel ON auditoria;
CREATE TRIGGER trg_auditoria_imutavel BEFORE UPDATE OR DELETE ON auditoria
  FOR EACH ROW EXECUTE FUNCTION auditoria_imutavel();

-- ------------------------------------------------------------ documentos
CREATE TABLE IF NOT EXISTS documento_gerado (
  id          TEXT PRIMARY KEY,
  tipo        TEXT NOT NULL,
  referencia_id TEXT,
  arquivo_url TEXT,
  hash        TEXT,
  gerado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
