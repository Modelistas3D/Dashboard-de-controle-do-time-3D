-- ============================================================
-- supabase_movimentacoes.sql
-- Histórico de movimentação dos cards entre as colunas do Trello.
--
-- É a base do gráfico "Vazão — peças finalizadas por período":
-- uma peça conta como concluída na data em que ENTROU numa coluna
-- Liberado / Feito do fluxo (Revisão Final ainda não é conclusão) —
-- e não pela coluna em que o card está parado hoje.
--
-- Como usar:
--   1. Acesse seu projeto em supabase.com
--   2. Vá em SQL Editor
--   3. Cole e execute este script
--   4. No dashboard, clique em "Sincronizar" para importar o histórico
-- ============================================================

CREATE TABLE IF NOT EXISTS movimentacoes (
    id            BIGSERIAL PRIMARY KEY,
    action_id     TEXT UNIQUE NOT NULL,   -- id da ação no Trello (evita duplicar no re-sync)
    trello_id     TEXT NOT NULL,          -- card movimentado
    card_nome     TEXT,
    data          TIMESTAMPTZ NOT NULL,   -- quando a movimentação aconteceu
    lista_antes   TEXT,                   -- coluna de origem
    lista_depois  TEXT,                   -- coluna de destino
    membro        TEXT,                   -- quem moveu o card
    criado_em     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Índices ────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_mov_data      ON movimentacoes (data);
CREATE INDEX IF NOT EXISTS idx_mov_card      ON movimentacoes (trello_id);
CREATE INDEX IF NOT EXISTS idx_mov_destino   ON movimentacoes (lista_depois);

-- ── Row Level Security ─────────────────────────────────────────
-- Mesma política da tabela `cards`: leitura pública (o dashboard usa a
-- publishable key), escrita apenas pela service_role (usada pelo sync).

ALTER TABLE movimentacoes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Leitura pública das movimentações" ON movimentacoes;
CREATE POLICY "Leitura pública das movimentações"
    ON movimentacoes
    FOR SELECT
    USING (true);

DROP POLICY IF EXISTS "Escrita apenas service_role nas movimentações" ON movimentacoes;
CREATE POLICY "Escrita apenas service_role nas movimentações"
    ON movimentacoes
    FOR ALL
    USING (auth.role() = 'service_role');

-- ── View de apoio: peças finalizadas por mês ───────────────────
-- Espelha a regra usada no dashboard: dentro do período (aqui, o mês),
-- cada card conta uma vez por fluxo, na 1ª entrada em Liberado/Feito
-- naquele mês. Útil para conferência no SQL.

CREATE OR REPLACE VIEW vazao_mensal AS
WITH finalizacoes AS (
    SELECT
        trello_id,
        CASE
            WHEN lower(lista_depois) LIKE '%revisão tq%' OR lower(lista_depois) LIKE '%revisao tq%' THEN 'Revisão TQ'
            WHEN lower(lista_depois) LIKE '%montagem%' THEN 'Montagem TQ'
            WHEN lower(lista_depois) LIKE '%ajuste%'   THEN 'Ajuste'
            WHEN lower(lista_depois) LIKE '%novo%'     THEN 'Novo'
        END                       AS fluxo,
        date_trunc('month', data) AS mes,
        MIN(data)                 AS finalizado_em
    FROM movimentacoes
    WHERE lower(lista_depois) NOT LIKE '%a fazer%'
      AND lower(lista_depois) NOT LIKE '%2d%'
      AND lower(lista_depois) NOT LIKE '%fazendo%'
      AND lower(lista_depois) NOT LIKE '%acervo%'
      AND lower(lista_depois) NOT LIKE '%old%'
      AND lower(lista_depois) NOT LIKE '%revisão final%'
      AND lower(lista_depois) NOT LIKE '%revisao final%'
      AND (
            lower(lista_depois) LIKE '%liberado%'
         OR lower(lista_depois) LIKE '%feito%'
      )
    GROUP BY 1, 2, 3
)
SELECT
    mes,
    fluxo,
    COUNT(*)                           AS pecas
FROM finalizacoes
WHERE fluxo IS NOT NULL
GROUP BY 1, 2
ORDER BY 1, 2;

COMMENT ON TABLE  movimentacoes              IS 'Ações updateCard:idList do Trello — histórico de movimentação entre colunas';
COMMENT ON COLUMN movimentacoes.action_id    IS 'ID da ação no Trello — chave de deduplicação entre syncs';
COMMENT ON COLUMN movimentacoes.lista_depois IS 'Coluna de destino — define se a movimentação é uma finalização';
