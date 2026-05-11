/**
 * sync.js — Netlify Function
 * ──────────────────────────
 * Endpoint: /.netlify/functions/sync
 * Método:   POST (ou GET)
 *
 * Replica a lógica do trello_extractor.py em JavaScript.
 * Busca cards do Trello e faz upsert no Supabase usando a service_role key.
 *
 * Variáveis de ambiente necessárias (Netlify → Site → Environment variables):
 *   TRELLO_API_KEY       — chave da API do Trello
 *   TRELLO_TOKEN         — token de acesso do Trello
 *   TRELLO_BOARD_ID      — ID do quadro (padrão: 7xdYwZjP)
 *   SUPABASE_URL         — URL do projeto Supabase
 *   SUPABASE_SERVICE_KEY — service_role key do Supabase (com permissão de escrita)
 */

// ─── CONSTANTES ────────────────────────────────────────────────────────────────

const TARGET_COLUMN      = "Montagem TQ Liberado/Feito";
const COR_MARCA          = "lime";        // "Marca | 🌺 Farm BR", "Marca | 🌎 Farm GL", etc.
const COR_COLECAO        = "yellow";      // "Coleção | MR", "Coleção | NEWNESS", etc.
const COR_ESTILISTA      = "orange";      // "Estilista | Cami", "Estilista | Alice", etc.
const COR_TIPO           = "pink_light";  // "Modelagem | AJUSTE", "Modelagem | NOVO"
const COR_COMPLEXIDADE   = "black_light"; // "Complexidade | 🟩 Baixa / 🟨 Média / 🟧 Alta"
const COR_FREELANCER     = "red_dark";    // "MODELISTA EXTERNO"
const COR_INV27          = "green";       // "Estação | INV27"
const NOME_FREELANCER    = "Modelista Externo";
const LOTE               = 100;

// ─── HELPERS TRELLO ─────────────────────────────────────────────────────────────

async function trelloGet(endpoint, params = {}, env) {
  const base = new URLSearchParams({
    key:   env.TRELLO_API_KEY,
    token: env.TRELLO_TOKEN,
    ...params,
  });
  const url = `https://api.trello.com/1${endpoint}?${base}`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trello ${res.status} — ${endpoint}: ${text}`);
  }
  return res.json();
}

// Remove emojis e caracteres especiais, normaliza para comparação
function normCol(s) {
  return s.replace(/[^\w\s]/g, " ").toLowerCase().replace(/\s+/g, " ").trim();
}

async function buscarColunas(boardId, env) {
  const todas = await trelloGet(`/boards/${boardId}/lists`, { filter: "open" }, env);
  const targetNorm = normCol(TARGET_COLUMN);
  const escopo = [];
  let encontrou = false;

  for (const col of todas) {
    escopo.push(col);
    if (normCol(col.name).includes(targetNorm) || normCol(col.name).includes("montagem tq liberado")) {
      encontrou = true;
      break;
    }
  }

  if (!encontrou) {
    console.warn(`[sync] Coluna '${TARGET_COLUMN}' não encontrada — usando todas as ${todas.length} colunas.`);
    return todas;
  }
  console.log(`[sync] ${escopo.length} colunas no escopo (até '${escopo[escopo.length-1].name}')`);
  return escopo;
}

async function buscarCards(boardId, idsColunas, env) {
  const todos = await trelloGet(`/boards/${boardId}/cards`, {
    fields:        "id,name,idList,labels,dateLastActivity,due,dueComplete",
    members:       "true",
    member_fields: "fullName,username",
    filter:        "open",
  }, env);
  const filtrados = todos.filter(c => idsColunas.has(c.idList));
  console.log(`[sync] ${filtrados.length} cards no escopo (de ${todos.length} total)`);
  return filtrados;
}

async function buscarAcoesMovimentacao(boardId, env) {
  console.log("[sync] Buscando histórico de movimentações...");
  let todas = [];
  let before = null;

  const since = new Date(Date.now() - 180 * 24 * 3_600_000).toISOString();
  const MAX_PAGES = 4;
  let pagina = 0;

  while (pagina < MAX_PAGES) {
    const params = { filter: "updateCard:idList", limit: "1000", since };
    if (before) params.before = before;

    const resultados = await trelloGet(`/boards/${boardId}/actions`, params, env);
    if (!resultados.length) break;
    todas = todas.concat(resultados);
    pagina++;
    if (resultados.length < 1000) break;
    before = resultados[resultados.length - 1].id;
  }

  const porCard = {};
  for (const a of todas) {
    const cardId = a?.data?.card?.id;
    if (cardId) {
      if (!porCard[cardId]) porCard[cardId] = [];
      porCard[cardId].push(a);
    }
  }
  for (const id of Object.keys(porCard)) {
    porCard[id].sort((a, b) => new Date(a.date) - new Date(b.date));
  }
  console.log(`[sync] ${todas.length} movimentações para ${Object.keys(porCard).length} cards`);
  return porCard;
}

// ─── DETECÇÃO DE ATRIBUTOS ───────────────────────────────────────────────────────

function detectarTipo(card, coluna = "") {
  // 1. Etiqueta pink_light "Modelagem | AJUSTE / NOVO" (fonte primária no Trello atual)
  for (const lbl of (card.labels || [])) {
    if (lbl.color === COR_TIPO) {
      const nome = (lbl.name || "").toLowerCase();
      if (nome.includes("ajuste")) return "Ajuste";
      if (nome.includes("novo") || nome.includes("nova")) return "Novo";
    }
  }
  // 2. Qualquer etiqueta com palavra-chave de tipo
  for (const lbl of (card.labels || [])) {
    const nome = (lbl.name || "").trim().toLowerCase();
    if (nome.includes("montagem")) return "Montagem";
    if (nome.includes("novo") || nome.includes("nova")) return "Novo";
    if (nome.includes("ajuste")) return "Ajuste";
  }
  // 3. Nome da coluna
  const col = coluna.toLowerCase();
  if (col.includes("montagem")) return "Montagem";
  if (col.includes("novo")) return "Novo";
  if (col.includes("ajuste")) return "Ajuste";
  return "Outro";
}

function detectarEstilista(card) {
  for (const lbl of (card.labels || [])) {
    if (lbl.color === COR_ESTILISTA) {
      const nome = (lbl.name || "").trim().replace(/^Estilista\s*\|\s*/i, "").trim();
      return nome || "Sem Nome";
    }
  }
  return "Sem Estilista";
}

function detectarColecaoMarca(card) {
  let colecao = "Sem Coleção";
  let marca   = "Outras";

  for (const lbl of (card.labels || [])) {
    if (lbl.color === COR_COLECAO && colecao === "Sem Coleção") {
      colecao = (lbl.name || "").trim() || "Sem Coleção";
    }
    if (lbl.color === COR_MARCA) {
      const texto = (lbl.name || "").trim();
      const semPrefixo = texto
        .replace(/^Marca\s*\|\s*/i, "")
        .replace(/^[^\p{L}]+/u, "")
        .trim();
      const sl = semPrefixo.toLowerCase();
      if      (sl.includes("farm br"))                                             marca = "Farm BR";
      else if (sl.includes("farm gl") || sl === "gl")                              marca = "GL";
      else if (sl.includes("maria fil") || sl.includes("filo") || sl.includes("filó")) marca = "Maria Filó";
      else if (semPrefixo)                                                          marca = semPrefixo;
    }
  }

  return [colecao, marca];
}

function detectarInv27(card) {
  return (card.labels || []).some(l => l.color === COR_INV27);
}

function detectarFreelancer(card) {
  if ((card.labels || []).some(l => l.color === COR_FREELANCER && (l.name || "").toUpperCase().includes("MODELISTA EXTERNO"))) {
    return true;
  }
  return (card.members || []).some(m => {
    const nome = (m.fullName || m.username || "").toLowerCase();
    return nome.includes(NOME_FREELANCER.toLowerCase());
  });
}

function listarMembros(card) {
  return (card.members || []).map(m => m.fullName || m.username || "Desconhecido");
}

// ─── CÁLCULO DE TEMPO ────────────────────────────────────────────────────────────

function calcularTempoMontagem(cardId, acoesPorCard) {
  const acoes = acoesPorCard[cardId] || [];
  if (!acoes.length) return null;

  let tempoTotal  = 0;
  let entradaMontagem = null;

  for (const acao of acoes) {
    const listaAntes  = (acao?.data?.listBefore?.name || "").toLowerCase();
    const listaDepois = (acao?.data?.listAfter?.name  || "").toLowerCase();
    const dataAcao    = new Date(acao.date);

    const isMontagem = s => s.includes("montagem") || s.includes("montar");

    if (isMontagem(listaDepois) && entradaMontagem === null) {
      entradaMontagem = dataAcao;
    }
    if (entradaMontagem && isMontagem(listaAntes)) {
      tempoTotal += (dataAcao - entradaMontagem) / 3_600_000;
      entradaMontagem = null;
    }
  }

  if (entradaMontagem) {
    tempoTotal += (Date.now() - entradaMontagem.getTime()) / 3_600_000;
  }

  return tempoTotal > 0 ? Math.round(tempoTotal * 100) / 100 : null;
}

function classificarComplexidade(horas) {
  if (horas === null || horas === undefined) return "Não calculado";
  if (horas <= 1) return "Baixa";
  if (horas <= 2) return "Média";
  return "Alta";
}

// ─── PROCESSAMENTO ────────────────────────────────────────────────────────────────

function detectarComplexidadeLabel(card) {
  for (const lbl of (card.labels || [])) {
    if (lbl.color === COR_COMPLEXIDADE) {
      const nome = (lbl.name || "").toLowerCase();
      if (nome.includes("baixa"))                            return "Baixa";
      if (nome.includes("média") || nome.includes("media")) return "Média";
      if (nome.includes("alta"))                             return "Alta";
    }
  }
  return null;
}

function processarCards(cardsRaw, mapaColunas, acoesPorCard) {
  const agora = new Date().toISOString();
  return cardsRaw.map(card => {
    const [colecao, marca] = detectarColecaoMarca(card);
    const tempoHoras = calcularTempoMontagem(card.id, acoesPorCard);
    const complexidade = detectarComplexidadeLabel(card) ?? classificarComplexidade(tempoHoras);
    return {
      trello_id:            card.id,
      nome:                 card.name || "",
      coluna:               mapaColunas[card.idList] || "Desconhecida",
      tipo:                 detectarTipo(card, mapaColunas[card.idList] || ""),
      estilista:            detectarEstilista(card),
      colecao,
      marca,
      membros:              JSON.stringify(listarMembros(card)),
      is_modelista_externo: detectarFreelancer(card),
      is_inv27:             detectarInv27(card),
      tempo_horas:          tempoHoras,
      complexidade,
      data_atividade:       card.dateLastActivity || null,
      extraido_em:          agora,
    };
  });
}

// ─── UPSERT SUPABASE ─────────────────────────────────────────────────────────────

async function upsertSupabase(cards, env) {
  const url = `${env.SUPABASE_URL}/rest/v1/cards?on_conflict=trello_id`;
  const headers = {
    "Content-Type":  "application/json",
    "apikey":        env.SUPABASE_SERVICE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    "Prefer":        "resolution=merge-duplicates",
  };

  let sincronizados = 0;
  for (let i = 0; i < cards.length; i += LOTE) {
    const lote = cards.slice(i, i + LOTE);
    const res  = await fetch(url, {
      method:  "POST",
      headers: { ...headers, "Prefer": "resolution=merge-duplicates,return=minimal" },
      body:    JSON.stringify(lote),
    });
    if (!res.ok) {
      const texto = await res.text();
      throw new Error(`Supabase upsert falhou (lote ${i / LOTE + 1}): ${res.status} — ${texto}`);
    }
    sincronizados += lote.length;
    console.log(`[sync] Lote ${i / LOTE + 1}: ${lote.length} cards enviados`);
  }
  return sincronizados;
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────────────────────────

const handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  const inicio = Date.now();

  const env = {
    TRELLO_API_KEY:       process.env.TRELLO_API_KEY,
    TRELLO_TOKEN:         process.env.TRELLO_TOKEN,
    TRELLO_BOARD_ID:      process.env.TRELLO_BOARD_ID      || "7xdYwZjP",
    SUPABASE_URL:         process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY,
  };

  const faltando = ["TRELLO_API_KEY", "TRELLO_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"]
    .filter(k => !env[k]);
  if (faltando.length) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        ok: false,
        erro: `Variáveis de ambiente não configuradas: ${faltando.join(", ")}`,
        dica: "Acesse Netlify → Site → Environment variables e adicione as chaves necessárias.",
      }),
    };
  }

  try {
    console.log("[sync] Iniciando extração do Trello...");

    const colunas    = await buscarColunas(env.TRELLO_BOARD_ID, env);
    const idsColunas = new Set(colunas.map(c => c.id));
    const mapaCols   = Object.fromEntries(colunas.map(c => [c.id, c.name]));

    const cardsRaw = await buscarCards(env.TRELLO_BOARD_ID, idsColunas, env);

    const acoesPorCard = await buscarAcoesMovimentacao(env.TRELLO_BOARD_ID, env);

    const cards = processarCards(cardsRaw, mapaCols, acoesPorCard);

    const total = await upsertSupabase(cards, env);

    const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
    console.log(`[sync] ✅ ${total} cards sincronizados em ${duracao}s`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok:         true,
        total,
        colunas:    colunas.length,
        duracao_s:  parseFloat(duracao),
        extraido_em: new Date().toISOString(),
      }),
    };

  } catch (err) {
    console.error("[sync] Erro:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        ok:   false,
        erro: err.message,
      }),
    };
  }
};

module.exports = { handler };
