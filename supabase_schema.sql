-- ============================================================
-- supabase_schema.sql
-- Schema do Supabase para o Dashboard de Análise Trello 3D
--
-- Como usar:
--   1. Acesse seu projeto em supabase.com
--   2. Vá em SQL Editor
--   3. Cole e execute este script
-- ============================================================

-- Tabela principal de cards
CREATE TABLE IF NOT EXISTS cards (
    id                    BIGSERIAL PRIMARY KEY,
    trello_id             TEXT UNIQUE NOT NULL,
    nome                  TEXT,
    coluna                TEXT,
    tipo                  TEXT,           -- Montagem | Novo | Ajuste | Outro
    estilista             TEXT,
    colecao               TEXT,
    marca                 TEXT,           -- Farm BR | GL | Maria Filó | Outras
    membros               TEXT,           -- JSON array serializado ex: '["Fulana","Ciclana"]'
    is_modelista_externo  BOOLEAN DEFAULT FALSE,
    is_inv27              BOOLEAN DEFAULT FALSE,
    tempo_horas           NUMERIC(8,2),   -- Tempo de montagem em horas (opcional)
    complexidade          TEXT,           -- Baixa | Média | Alta | Não calculado
    data_atividade        TIMESTAMPTZ,
    extraido_em           TIMESTAMPTZ DEFAULT NOW(),
    created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ── Índices para queries rápidas no dashboard ──────────────────

CREATE INDEX IF NOT EXISTS idx_cards_tipo       ON cards (tipo);
CREATE INDEX IF NOT EXISTS idx_cards_marca      ON cards (marca);
CREATE INDEX IF NOT EXISTS idx_cards_estilista  ON cards (estilista);
CREATE INDEX IF NOT EXISTS idx_cards_colecao    ON cards (colecao);
CREATE INDEX IF NOT EXISTS idx_cards_freelancer ON cards (is_modelista_externo);
CREATE INDEX IF NOT EXISTS idx_cards_inv27      ON cards (is_inv27);


-- ── Row Level Security (RLS) ───────────────────────────────────
-- Habilita leitura pública para que o dashboard no Netlify
-- possa buscar dados com a anon key (sem autenticação)

ALTER TABLE cards ENABLE ROW LEVEL SECURITY;

-- Política: qualquer pessoa pode LER os cards
CREATE POLICY "Leitura pública dos cards"
    ON cards
    FOR SELECT
    USING (true);

-- Política: apenas service_role pode INSERIR / ATUALIZAR / DELETAR
-- (o Python extractor usa a service_role key, nunca a anon key)
CREATE POLICY "Escrita apenas service_role"
    ON cards
    FOR ALL
    USING (auth.role() = 'service_role');


-- ── View de resumo (opcional — facilita queries no dashboard) ──

CREATE OR REPLACE VIEW resumo_por_marca AS
SELECT
    marca,
    tipo,
    COUNT(*) AS total
FROM cards
GROUP BY marca, tipo
ORDER BY marca, tipo;

CREATE OR REPLACE VIEW resumo_por_estilista AS
SELECT
    estilista,
    colecao,
    tipo,
    COUNT(*) AS total
FROM cards
GROUP BY estilista, colecao, tipo
ORDER BY estilista, colecao, tipo;

CREATE OR REPLACE VIEW resumo_por_complexidade AS
SELECT
    complexidade,
    COUNT(*)                        AS total,
    ROUND(AVG(tempo_horas), 2)      AS tempo_medio_horas
FROM cards
WHERE tempo_horas IS NOT NULL
GROUP BY complexidade;


-- ── Comentários nas colunas ────────────────────────────────────

COMMENT ON COLUMN cards.trello_id            IS 'ID único do card no Trello';
COMMENT ON COLUMN cards.tipo                 IS 'Montagem | Novo | Ajuste — detectado via etiqueta ou nome do card';
COMMENT ON COLUMN cards.estilista            IS 'Nome da estilista — etiqueta laranja do Trello';
COMMENT ON COLUMN cards.colecao              IS 'Nome da coleção — etiqueta amarela do Trello';
COMMENT ON COLUMN cards.marca               IS 'Farm BR | GL | Maria Filó | Outras — inferido da coleção';
COMMENT ON COLUMN cards.membros              IS 'JSON com array dos nomes dos membros do card';
COMMENT ON COLUMN cards.is_modelista_externo IS 'TRUE se "Modelista Externo" for membro (trabalho freelancer)';
COMMENT ON COLUMN cards.is_inv27             IS 'TRUE se o card tiver etiqueta verde (Estação | Inv 27)';
COMMENT ON COLUMN cards.tempo_horas          IS 'Tempo total em colunas de montagem, em horas';
COMMENT ON COLUMN cards.complexidade         IS 'Baixa (≤1h) | Média (≤2h) | Alta (>2h)';
