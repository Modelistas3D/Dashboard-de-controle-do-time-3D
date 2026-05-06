/**
 * sync.js — Netlify Function
 * Endpoint: /.netlify/functions/sync
 * Método:   POST (ou GET)
 *
 * Limita histórico a 6 meses (since) e 4 páginas (4.000 ações)
 * para evitar timeout da Netlify Function (10s free tier).
 */

// ─── CONSTANTES ──────────────────────────────────────────────────────────────

const TARGET_COLUMN   = "Montagem TQ Liberado/Feito";
const COR_ESTILISTA   = "orange";
const CORES_COLECAO   = ["yellow", "yellow_dark"];
const COR_INV27       = "green";
const MARCAS          = ["Farm BR", "GL", "Maria Filó"];
const NOME_FREELANCER = "Modelista Externo";
const LOTE            = 100;

// ─── HELPERS TRELLO ──────────────────────────────────────────────────────────

async function trelloGet(endpoint, params = {}, env) {
  const base = new URLSearchParams({
    key:   env.TRELLO_API_KEY,
    token: env.TRELLO_TOKEN,
    ...params,
  });
  const url = `https://api.trello.com/1${endpoint}?${base}`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trello ${res.status} — ${endpoint}: ${text}`);
  }
  return res.json();
}

async function buscarColunas(boardId, env) {
  const todas = await trelloGet(`/boards/${boardId}/lists`, { filter: "open" }, env);
  const escopo = [];
  for (const col of todas) {
    escopo.push(col);
    if (col.name.trim() === TARGET_COLUMN.trim()) break;
  }
  if (escopo.length === todas.length && todas[todas.length - 1]?.name.trim() !== TARGET_COLUMN.trim()) {
    console.warn(`[sync] Coluna alvo não encontrada — usando todas as ${todas.length} colunas.`);
    return todas;
  }
  console.log(`[sync] ${escopo.length} colunas no escopo`);
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
  console.log("[sync] Buscando histórico de movimentações (últimos 6 meses)...");
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

// ─── DETECÇÃO DE ATRIBUTOS ───────────────────────────────────────────────────

function detectarTipo(card) {
  for (const lbl of (card.labels || [])) {
    const nome = (lbl.name || "").trim().toLowerCase();
    if (nome.includes("montagem")) return "Montagem";
    if (nome.includes("novo") || nome.includes("nova")) return "Novo";
    if (nome.includes("ajuste")) return "Ajuste";
  }
  const nomeCard = (card.name || "").toLowerCase();
  if (nomeCard.includes("montagem")) return "Montagem";
  if (nomeCard.includes("novo") || nomeCard.includes("nova")) return "Novo";
  if (nomeCard.includes("ajuste")) return "Ajuste";
  return "Outro";
}

function detectarEstilista(card) {
  for (const lbl of (card.labels || [])) {
    if (lbl.color === COR_ESTILISTA) return (lbl.name || "").trim() || "Sem Nome";
  }
  return "Sem Estilista";
}

function detectarColecaoMarca(card) {
  for (const lbl of (card.labels || [])) {
    if (CORES_COLECAO.includes(lbl.color)) {
      const texto = (lbl.name || "").trim();
      let marca = "Outras";
      for (const m of MARCAS) {
        if (texto.toLowerCase().includes(m.toLowerCase())) { marca = m; break; }
      }
      return [texto || "Sem Coleção", marca];
    }
  }
  return ["Sem Coleção", "Outras"];
}

function detectarInv27(card) {
  return (card.labels || []).some(l => l.color === COR_INV27);
}

function detectarFreelancer(card) {
  return (card.members || []).some(m => {
    const nome = (m.fullName || m.username || "").toLowerCase();
    return nome.includes(NOME_FREELANCER.toLowerCase());
  });
}

function listarMembros(card) {
  return (card.members || []).map(m => m.fullName || m.username || "Desconhecido");
}

// ─── CÁLCULO DE TEMPO ────────────────────────────────────────────────────────

function calcularTempoMontagem(cardId, acoesPorCard) {
  const acoes = acoesPorCard[cardId] || [];
  if (!acoes.length) return null;
  let tempoTotal = 0;
  let entradaMontagem = null;
  const isMontagem = s => s.includes("montagem") || s.includes("montar");
  for (const acao of acoes) {
    const listaAntes  = (acao?.data?.listBefore?.name || "").toLowerCase();
    const listaDepois = (acao?.data?.listAfter?.name  || "").toLowerCase();
    const dataAcao    = new Date(acao.date);
    if (isMontagem(listaDepois) && entradaMontagem === null) entradaMontagem = dataAcao;
    if (entradaMontagem && isMontagem(listaAntes)) {
      tempoTotal += (dataAcao - entradaMontagem) / 3_600_000;
      entradaMontagem = null;
    }
  }
  if (entradaMontagem) tempoTotal += (Date.now() - entradaMontagem.getTime()) / 3_600_000;
  return tempoTotal > 0 ? Math.round(tempoTotal * 100) / 100 : null;
}

function classificarComplexidade(horas) {
  if (horas === null || horas === undefined) return "Não calculado";
  if (horas <= 1) return "Baixa";
  if (horas <= 2) return "Média";
  return "Alta";
}

// ─── PROCESSAMENTO ───────────────────────────────────────────────────────────

function processarCards(cardsRaw, mapaColunas, acoesPorCard) {
  const agora = new Date().toISOString();
  return cardsRaw.map(card => {
    const [colecao, marca] = detectarColecaoMarca(card);
    const tempoHoras = calcularTempoMontagem(card.id, acoesPorCard);
    return {
      trello_id:            card.id,
      nome:                 card.name || "",
      coluna:               mapaColunas[card.idList] || "Desconhecida",
      tipo:                 detectarTipo(card),
      estilista:            detectarEstilista(card),
      colecao,
      marca,
      membros:              JSON.stringify(listarMembros(card)),
      is_modelista_externo: detectarFreelancer(card),
      is_inv27:             detectarInv27(card),
      tempo_horas:          tempoHoras,
      complexidade:         classificarComplexidade(tempoHoras),
      data_atividade:       card.dateLastActivity || null,
      extraido_em:          agora,
    };
  });
}

// ─── UPSERT SUPABASE ─────────────────────────────────────────────────────────

async function upsertSupabase(cards, env) {
  const url = `${env.SUPABASE_URL}/rest/v1/cards`;
  const headers = {
    "Content-Type":  "application/json",
    "apikey":        env.SUPABASE_SERVICE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
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
  }
  return sincronizados;
}

// ─── HANDLER PRINCIPAL ───────────────────────────────────────────────────────

const handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  const inicio = Date.now();
  const env = {
    TRELLO_API_KEY:       process.env.TRELLO_API_KEY,
    TRELLO_TOKEN:         process.env.TRELLO_TOKEN,
    TRELLO_BOARD_ID:      process.env.TRELLO_BOARD_ID || "7xdYwZjP",
    SUPABASE_URL:         process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
  };

  const faltando = ["TRELLO_API_KEY", "TRELLO_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"]
    .filter(k => !env[k]);
  if (faltando.length) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ ok: false, erro: `Vars faltando: ${faltando.join(", ")}` }),
    };
  }

  try {
    const colunas    = await buscarColunas(env.TRELLO_BOARD_ID, env);
    const idsColunas = new Set(colunas.map(c => c.id));
    const mapaCols   = Object.fromEntries(colunas.map(c => [c.id, c.name]));
    const cardsRaw   = await buscarCards(env.TRELLO_BOARD_ID, idsColunas, env);
    const acoesPorCard = await buscarAcoesMovimentacao(env.TRELLO_BOARD_ID, env);
    const cards      = processarCards(cardsRaw, mapaCols, acoesPorCard);
    const total      = await upsertSupabase(cards, env);
    const duracao    = ((Date.now() - inicio) / 1000).toFixed(1);
    console.log(`[sync] ✅ ${total} cards sincronizados em ${duracao}s`);
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ ok: true, total, colunas: colunas.length, duracao_s: parseFloat(duracao), extraido_em: new Date().toISOString() }),
    };
  } catch (err) {
    console.error("[sync] Erro:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, erro: err.message }) };
  }
};

module.exports = { handler };
