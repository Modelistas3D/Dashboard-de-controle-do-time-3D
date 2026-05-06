/**
 * sync.js — Netlify Function
 * Endpoint: /.netlify/functions/sync
 * Método:   POST
 */

const TARGET_COLUMN   = "Montagem TQ Liberado/Feito";
const COR_ESTILISTA   = "orange";
const CORES_COLECAO   = ["yellow", "yellow_dark"];
const COR_INV27       = "green";
const MARCAS          = ["Farm BR", "GL", "Maria Filó"];
const NOME_FREELANCER = "Modelista Externo";
const LOTE            = 100;

async function trelloGet(endpoint, params = {}, env) {
  const base = new URLSearchParams({ key: env.TRELLO_API_KEY, token: env.TRELLO_TOKEN, ...params });
  const url = `https://api.trello.com/1${endpoint}?${base}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Trello ${res.status} — ${endpoint}: ${await res.text()}`);
  return res.json();
}

async function buscarColunas(boardId, env) {
  const todas = await trelloGet(`/boards/${boardId}/lists`, { filter: "open" }, env);
  const escopo = [];
  for (const col of todas) {
    escopo.push(col);
    if (col.name.trim() === TARGET_COLUMN.trim()) break;
  }
  return escopo;
}

async function buscarCards(boardId, idsColunas, env) {
  const todos = await trelloGet(`/boards/${boardId}/cards`, {
    fields: "id,name,idList,labels,dateLastActivity", members: "true", member_fields: "fullName,username", filter: "open",
  }, env);
  return todos.filter(c => idsColunas.has(c.idList));
}

async function buscarAcoesMovimentacao(boardId, env) {
  let todas = [], before = null;
  while (true) {
    const params = { filter: "updateCard:idList", limit: "1000" };
    if (before) params.before = before;
    const res = await trelloGet(`/boards/${boardId}/actions`, params, env);
    if (!res.length) break;
    todas = todas.concat(res);
    if (res.length < 1000) break;
    before = res[res.length - 1].id;
  }
  const porCard = {};
  for (const a of todas) {
    const id = a?.data?.card?.id;
    if (id) { if (!porCard[id]) porCard[id] = []; porCard[id].push(a); }
  }
  for (const id of Object.keys(porCard)) porCard[id].sort((a, b) => new Date(a.date) - new Date(b.date));
  return porCard;
}

function detectarTipo(card) {
  for (const l of (card.labels || [])) {
    const n = (l.name || "").toLowerCase();
    if (n.includes("montagem")) return "Montagem";
    if (n.includes("novo") || n.includes("nova")) return "Novo";
    if (n.includes("ajuste")) return "Ajuste";
  }
  return "Outro";
}

function detectarEstilista(card) {
  for (const l of (card.labels || [])) if (l.color === COR_ESTILISTA) return (l.name || "").trim() || "Sem Nome";
  return "Sem Estilista";
}

function detectarColecaoMarca(card) {
  for (const l of (card.labels || [])) {
    if (CORES_COLECAO.includes(l.color)) {
      const t = (l.name || "").trim();
      let marca = "Outras";
      for (const m of MARCAS) if (t.toLowerCase().includes(m.toLowerCase())) { marca = m; break; }
      return [t || "Sem Coleção", marca];
    }
  }
  return ["Sem Coleção", "Outras"];
}

function detectarInv27(card) { return (card.labels || []).some(l => l.color === COR_INV27); }
function detectarFreelancer(card) {
  return (card.members || []).some(m => (m.fullName || m.username || "").toLowerCase().includes(NOME_FREELANCER.toLowerCase()));
}
function listarMembros(card) { return (card.members || []).map(m => m.fullName || m.username || "Desconhecido"); }

function calcularTempo(cardId, acoesPorCard) {
  const acoes = acoesPorCard[cardId] || [];
  if (!acoes.length) return null;
  let total = 0, entrada = null;
  const isM = s => s.includes("montagem") || s.includes("montar");
  for (const a of acoes) {
    const antes = (a?.data?.listBefore?.name || "").toLowerCase();
    const depois = (a?.data?.listAfter?.name || "").toLowerCase();
    const dt = new Date(a.date);
    if (isM(depois) && !entrada) entrada = dt;
    if (entrada && isM(antes)) { total += (dt - entrada) / 3_600_000; entrada = null; }
  }
  if (entrada) total += (Date.now() - entrada.getTime()) / 3_600_000;
  return total > 0 ? Math.round(total * 100) / 100 : null;
}

function classificarComplexidade(h) {
  if (!h) return "Não calculado";
  if (h <= 1) return "Baixa";
  if (h <= 2) return "Média";
  return "Alta";
}

function processarCards(cardsRaw, mapaColunas, acoesPorCard) {
  const agora = new Date().toISOString();
  return cardsRaw.map(card => {
    const [colecao, marca] = detectarColecaoMarca(card);
    const t = calcularTempo(card.id, acoesPorCard);
    return { trello_id: card.id, nome: card.name || "", coluna: mapaColunas[card.idList] || "Desconhecida",
      tipo: detectarTipo(card), estilista: detectarEstilista(card), colecao, marca,
      membros: JSON.stringify(listarMembros(card)), is_modelista_externo: detectarFreelancer(card),
      is_inv27: detectarInv27(card), tempo_horas: t, complexidade: classificarComplexidade(t),
      data_atividade: card.dateLastActivity || null, extraido_em: agora };
  });
}

async function upsertSupabase(cards, env) {
  const url = `${env.SUPABASE_URL}/rest/v1/cards`;
  const h = { "Content-Type": "application/json", "apikey": env.SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`, "Prefer": "resolution=merge-duplicates,return=minimal" };
  let n = 0;
  for (let i = 0; i < cards.length; i += LOTE) {
    const lote = cards.slice(i, i + LOTE);
    const res = await fetch(url, { method: "POST", headers: h, body: JSON.stringify(lote) });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    n += lote.length;
  }
  return n;
}

const handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  const env = {
    TRELLO_API_KEY: process.env.TRELLO_API_KEY,
    TRELLO_TOKEN: process.env.TRELLO_TOKEN,
    TRELLO_BOARD_ID: process.env.TRELLO_BOARD_ID || "7xdYwZjP",
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
  };
  const faltando = ["TRELLO_API_KEY","TRELLO_TOKEN","SUPABASE_URL","SUPABASE_SERVICE_KEY"].filter(k => !env[k]);
  if (faltando.length) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, erro: `Vars não configuradas: ${faltando.join(", ")}` }) };
  try {
    const inicio = Date.now();
    const colunas = await buscarColunas(env.TRELLO_BOARD_ID, env);
    const idsColunas = new Set(colunas.map(c => c.id));
    const mapaCols = Object.fromEntries(colunas.map(c => [c.id, c.name]));
    const cardsRaw = await buscarCards(env.TRELLO_BOARD_ID, idsColunas, env);
    const acoesPorCard = await buscarAcoesMovimentacao(env.TRELLO_BOARD_ID, env);
    const cards = processarCards(cardsRaw, mapaCols, acoesPorCard);
    const total = await upsertSupabase(cards, env);
    const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
    console.log(`[sync] ✅ ${total} cards em ${duracao}s`);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, total, colunas: colunas.length, duracao_s: parseFloat(duracao), extraido_em: new Date().toISOString() }) };
  } catch (err) {
    console.error("[sync] Erro:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, erro: err.message }) };
  }
};

module.exports = { handler };
