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
const LOTE               = 500;  // lote maior = menos requisições no upsert (importante com o acervo)
const MAX_PAGES_ACOES    = 3;    // teto de 3.000 movimentações por execução (o histórico completo entra em alguns syncs, sem estourar o tempo da function)
const LOTE_MOV           = 1000; // movimentações por request no upsert
const JANELA_INICIAL_DIAS= 540;  // primeira carga do histórico: ~18 meses

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

// normCol descarta letras acentuadas ("Revisão" → "revis o"), então aqui
// removemos só os acentos antes de comparar.
function isRevisaoTQ(nome) {
  const c = (nome || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return c.includes("revisao tq") && !c.includes("old");
}

async function buscarColunas(boardId, env) {
  const todas = await trelloGet(`/boards/${boardId}/lists`, { filter: "open" }, env);
  const targetNorm = normCol(TARGET_COLUMN);
  const escopo = [];
  let encontrou = false;

  for (const col of todas) {
    escopo.push(col);
    // Comparação normalizada: ignora emojis, | vs /, maiúsculas
    if (normCol(col.name).includes(targetNorm) || normCol(col.name).includes("montagem tq liberado")) {
      encontrou = true;
      break;
    }
  }

  if (!encontrou) {
    console.warn(`[sync] Coluna '${TARGET_COLUMN}' não encontrada — usando todas as ${todas.length} colunas.`);
    return todas;
  }

  // Além do escopo de produção (até a coluna alvo), incluímos também as colunas
  // de ACERVO GERAL — mesmo que venham depois no quadro. O dashboard decide,
  // via filtro "Produção / Produção + Acervo", se mostra ou não esses cards.
  const jaNoEscopo = new Set(escopo.map(c => c.id));
  const acervo = todas.filter(c => normCol(c.name).includes("acervo") && !jaNoEscopo.has(c.id));
  if (acervo.length) {
    escopo.push(...acervo);
    console.log(`[sync] +${acervo.length} coluna(s) de acervo incluída(s): ${acervo.map(c => c.name).join(", ")}`);
  }

  // Colunas "🔍 Revisão TQ | …" ficam depois da coluna alvo no quadro, mas são
  // um fluxo próprio que o dashboard acompanha. As antigas "Revisão TQ OLD" ficam de fora.
  acervo.forEach(c => jaNoEscopo.add(c.id));
  const revisao = todas.filter(c => isRevisaoTQ(c.name) && !jaNoEscopo.has(c.id));
  if (revisao.length) {
    escopo.push(...revisao);
    console.log(`[sync] +${revisao.length} coluna(s) de Revisão TQ incluída(s): ${revisao.map(c => c.name).join(", ")}`);
  }

  console.log(`[sync] ${escopo.length} colunas no escopo`);
  return escopo;
}

async function buscarCards(boardId, idsColunas, env) {
  const todos = await trelloGet(`/boards/${boardId}/cards`, {
    fields:        "id,name,idList,labels,dateLastActivity,due,dueComplete,desc",
    members:       "true",
    member_fields: "fullName,username",
    filter:        "open",
  }, env);
  const filtrados = todos.filter(c => idsColunas.has(c.idList));
  console.log(`[sync] ${filtrados.length} cards no escopo (de ${todos.length} total)`);
  return filtrados;
}

// Busca as ações de movimentação entre colunas (updateCard:idList).
// `since` recorta a janela: no sync incremental usamos a data da última
// movimentação já gravada, o que mantém a chamada rápida no dia a dia.
// O Trello devolve as ações da mais nova para a mais antiga; `before` caminha
// para trás no tempo. `truncado: true` avisa que o teto de páginas foi atingido
// e ainda há histórico mais antigo a buscar na próxima execução.
async function buscarAcoesMovimentacao(boardId, env, since, before, maxPaginas) {
  console.log(`[sync] Movimentações desde ${since}${before ? ` (antes de ${before})` : ""}...`);
  let todas = [];
  let cursor = before || null;
  let pagina = 0;
  let truncado = false;

  while (true) {
    if (pagina >= maxPaginas) { truncado = true; break; }
    const params = { filter: "updateCard:idList", limit: "1000", since };
    if (cursor) params.before = cursor;

    const resultados = await trelloGet(`/boards/${boardId}/actions`, params, env);
    if (!resultados.length) break;
    todas = todas.concat(resultados);
    pagina++;
    if (resultados.length < 1000) break;   // acabou o histórico da janela
    cursor = resultados[resultados.length - 1].id;
  }

  console.log(`[sync] ${todas.length} movimentações recebidas${truncado ? " (truncado)" : ""}`);
  return { acoes: todas, truncado };
}

// Converte as ações do Trello em linhas da tabela `movimentacoes`.
function processarMovimentacoes(acoes) {
  const linhas = [];
  const vistos = new Set();
  for (const a of acoes) {
    const cardId = a?.data?.card?.id;
    const depois = a?.data?.listAfter?.name;
    if (!cardId || !a.id || !a.date || vistos.has(a.id)) continue;
    vistos.add(a.id);
    linhas.push({
      action_id:    a.id,
      trello_id:    cardId,
      card_nome:    a?.data?.card?.name || null,
      data:         a.date,
      lista_antes:  a?.data?.listBefore?.name || null,
      lista_depois: depois || null,
      membro:       a?.memberCreator?.fullName || a?.memberCreator?.username || null,
    });
  }
  return linhas;
}

// Extremos do histórico já gravado — âncoras dos dois sentidos do sync:
// a mais nova puxa o que aconteceu desde o último sync; a mais antiga serve de
// cursor para continuar preenchendo o passado a cada execução.
async function limitesMovimentacoes(env) {
  const headers = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` };
  const uma = async (ordem) => {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/movimentacoes?select=action_id,data&order=data.${ordem}&limit=1`,
      { headers }
    );
    if (!res.ok) return undefined;       // tabela ainda não existe
    const linhas = await res.json();
    return Array.isArray(linhas) && linhas.length ? linhas[0] : null;
  };
  try {
    const nova = await uma("desc");
    if (nova === undefined) return { semTabela: true };
    if (nova === null) return { vazia: true };
    const antiga = await uma("asc");
    return { vazia: false, nova, antiga: antiga || nova };
  } catch (e) {
    console.warn("[sync] Não foi possível ler os limites das movimentações:", e.message);
    return null;
  }
}

async function upsertMovimentacoes(linhas, env) {
  if (!linhas.length) return 0;
  const url = `${env.SUPABASE_URL}/rest/v1/movimentacoes?on_conflict=action_id`;
  const headers = {
    "Content-Type":  "application/json",
    "apikey":        env.SUPABASE_SERVICE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    "Prefer":        "resolution=merge-duplicates,return=minimal",
  };
  let enviados = 0;
  for (let i = 0; i < linhas.length; i += LOTE_MOV) {
    const lote = linhas.slice(i, i + LOTE_MOV);
    const res  = await fetch(url, { method: "POST", headers, body: JSON.stringify(lote) });
    if (!res.ok) {
      const texto = await res.text();
      throw new Error(`Supabase upsert movimentacoes (lote ${i / LOTE_MOV + 1}): ${res.status} — ${texto}`);
    }
    enviados += lote.length;
  }
  return enviados;
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
  // 3. Nome da coluna (ex: "🚀 Montagem TQ | Fazendo" → Montagem)
  const col = coluna.toLowerCase();
  if (col.includes("montagem")) return "Montagem";
  if (col.includes("novo")) return "Novo";
  if (col.includes("ajuste")) return "Ajuste";
  return "Outro";
}

function detectarEstilista(card) {
  for (const lbl of (card.labels || [])) {
    if (lbl.color === COR_ESTILISTA) {
      // Remove prefixo "Estilista | " se presente
      const nome = (lbl.name || "").trim().replace(/^Estilista\s*\|\s*/i, "").trim();
      return nome || "Sem Nome";
    }
  }
  return "Sem Estilista";
}

function detectarColecaoMarca(card) {
  let colecao = "Sem Coleção";
  let marca   = "Outras";
  let colecaoSet = false;

  for (const lbl of (card.labels || [])) {
    // Coleção: etiqueta amarela "Coleção | MR", "Coleção | NEWNESS", etc.
    // Remove o prefixo "Coleção | " para guardar só o nome limpo (ex: "MR").
    if (lbl.color === COR_COLECAO && !colecaoSet) {
      const nome = (lbl.name || "").trim().replace(/^Cole[cç][aã]o\s*\|\s*/i, "").trim();
      colecao = nome || "Sem Coleção";
      colecaoSet = true;
    }
    // Marca: etiqueta lime "Marca | 🌺 Farm BR", "Marca | 🌎 Farm GL", etc.
    if (lbl.color === COR_MARCA) {
      const texto = (lbl.name || "").trim();
      // Remove prefixo "Marca | " e strip de emojis/símbolos iniciais
      const semPrefixo = texto
        .replace(/^Marca\s*\|\s*/i, "")
        .replace(/^[^\p{L}]+/u, "")
        .trim();
      // Normaliza para os valores usados nos chips do dashboard
      const sl = semPrefixo.toLowerCase();
      if      (sl.includes("farm br"))                      marca = "Farm BR";
      else if (sl.includes("farm gl") || sl === "gl")       marca = "GL";
      else if (sl.includes("maria fil") || sl.includes("filo") || sl.includes("filó")) marca = "Maria Filó";
      else if (semPrefixo)                                   marca = semPrefixo;
    }
  }

  return [colecao, marca];
}

function detectarInv27(card) {
  return (card.labels || []).some(l => l.color === COR_INV27);
}

// Estação: etiqueta verde "Estação | AI26", "Estação | INV27", "ESTAÇÃO | HS27", etc.
// Hoje TODAS as estações usam a cor verde — não só a INV27 — então capturamos
// o código completo (ex: "AI26", "INV27", "VER28") em vez de um booleano.
function detectarEstacao(card) {
  for (const lbl of (card.labels || [])) {
    if (lbl.color === COR_INV27) {
      const nome = (lbl.name || "").trim().replace(/^Esta[cç][aã]o\s*\|\s*/i, "").trim();
      return nome || "Sem Estação";
    }
  }
  return "Sem Estação";
}

function detectarFreelancer(card) {
  // 1. Etiqueta red_dark "MODELISTA EXTERNO" (fonte primária no Trello atual)
  if ((card.labels || []).some(l => l.color === COR_FREELANCER && (l.name || "").toUpperCase().includes("MODELISTA EXTERNO"))) {
    return true;
  }
  // 2. Fallback: membro com nome "Modelista Externo"
  return (card.members || []).some(m => {
    const nome = (m.fullName || m.username || "").toLowerCase();
    return nome.includes(NOME_FREELANCER.toLowerCase());
  });
}

// ─── PARSER DE TEMPO (descrição do card) ──────────────────────────────────
// Lê a linha HH:MM logo abaixo de "SOMA TOTAL DO TEMPO DE TRABALHO".
// Ancora na palavra-chave (não no emoji, que pode vir corrompido da API).
// Retorna null quando não há tempo preenchido — o card fica de fora das médias.
function parseTempoDescricao(desc) {
  if (!desc) return null;
  const idx = desc.toUpperCase().indexOf("TEMPO DE TRABALHO");
  if (idx === -1) return null;
  const m = desc.slice(idx).match(/(\d{1,2})\s*[:hH]\s*(\d{2})/); // "02:30" ou "2h30"
  if (!m) return null;
  const horas = parseInt(m[1], 10), minutos = parseInt(m[2], 10);
  if (isNaN(horas) || isNaN(minutos)) return null;
  const total = horas + minutos / 60;
  return total > 0 ? Math.round(total * 100) / 100 : null;
}

// ─── DETECÇÃO DE RETRABALHO (etiquetas) ───────────────────────────────────
// Etiquetas "retrabalho molde | 3" e "retrabalho arte | 2".
// Casa pelo NOME (não pela cor), lê o número após o "|".
function detectarRetrabalho(card, palavra) { // palavra: "molde" ou "arte"
  for (const lbl of (card.labels || [])) {
    const nome = (lbl.name || "").toLowerCase();
    if (nome.includes("retrabalho") && nome.includes(palavra)) {
      const n = parseInt((nome.split("|")[1] || "").trim(), 10);
      if (!isNaN(n)) return n;
    }
  }
  return 0; // sem etiqueta = sem retrabalho (0 é valor real, não dado faltando)
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
      if (nome.includes("baixa"))                          return "Baixa";
      if (nome.includes("média") || nome.includes("media")) return "Média";
      if (nome.includes("alta"))                           return "Alta";
    }
  }
  return null; // sem etiqueta explícita → cair no cálculo por tempo
}

function processarCards(cardsRaw, mapaColunas, acoesPorCard) {
  const agora = new Date().toISOString();
  return cardsRaw.map(card => {
    const [colecao, marca] = detectarColecaoMarca(card);
    // Tempo: fonte única = valor digitado na descrição. Sem fallback:
    // card sem a linha de tempo fica null e é excluído das médias.
    const tempoHoras = parseTempoDescricao(card.desc);
    // Usa etiqueta de complexidade se disponível; senão calcula pelo tempo
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
      estacao:              detectarEstacao(card),
      tempo_horas:          tempoHoras,
      retrabalho_molde:     detectarRetrabalho(card, "molde"),
      retrabalho_arte:      detectarRetrabalho(card, "arte"),
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

// ─── LIMPEZA DE OBSOLETOS ────────────────────────────────────────────────────────
// Remove do Supabase cards que não estão mais no escopo atual do Trello.
// Isso evita acúmulo de registros antigos após múltiplos syncs.

async function limparObsoletos(idsAtivos, env) {
  if (!idsAtivos.length) return 0;

  // Supabase REST: DELETE WHERE trello_id NOT IN (id1, id2, ...)
  // Enviamos os IDs no body via RPC-style para evitar URL muito longa.
  // Alternativa segura: buscar todos os IDs do banco e deletar os que não estão na lista.
  const headers = {
    "apikey":        env.SUPABASE_SERVICE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    "Content-Type":  "application/json",
    "Prefer":        "return=minimal",
  };

  // 1. Busca todos os trello_id atualmente no banco
  const selectRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/cards?select=trello_id`,
    { headers }
  );
  if (!selectRes.ok) {
    console.warn(`[sync] Limpeza: falha ao buscar IDs do banco — ${selectRes.status}`);
    return 0;
  }
  const todos = await selectRes.json();
  const ativosSet = new Set(idsAtivos);
  const obsoletos = todos.map(r => r.trello_id).filter(id => !ativosSet.has(id));

  if (!obsoletos.length) {
    console.log("[sync] Limpeza: nenhum registro obsoleto encontrado.");
    return 0;
  }

  // 2. Deleta em lotes de 100 (URL segura)
  let deletados = 0;
  for (let i = 0; i < obsoletos.length; i += 100) {
    const lote = obsoletos.slice(i, i + 100);
    const ids  = lote.map(id => `"${id}"`).join(",");
    const delRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/cards?trello_id=in.(${ids})`,
      { method: "DELETE", headers }
    );
    if (!delRes.ok) {
      const texto = await delRes.text();
      console.warn(`[sync] Limpeza: erro ao deletar lote — ${delRes.status}: ${texto}`);
    } else {
      deletados += lote.length;
    }
  }

  console.log(`[sync] Limpeza: ${deletados} registros obsoletos removidos do Supabase.`);
  return deletados;
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────────────────────────

const handler = async (event) => {
  // CORS — permite chamadas do frontend no mesmo domínio Netlify
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

  // Lê variáveis de ambiente
  const env = {
    TRELLO_API_KEY:       process.env.TRELLO_API_KEY,
    TRELLO_TOKEN:         process.env.TRELLO_TOKEN,
    TRELLO_BOARD_ID:      process.env.TRELLO_BOARD_ID      || "7xdYwZjP",
    SUPABASE_URL:         process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY,
  };

  // Validação
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

    // 1. Colunas no escopo
    const colunas    = await buscarColunas(env.TRELLO_BOARD_ID, env);
    const idsColunas = new Set(colunas.map(c => c.id));
    const mapaCols   = Object.fromEntries(colunas.map(c => [c.id, c.name]));

    // 2. Cards
    const cardsRaw = await buscarCards(env.TRELLO_BOARD_ID, idsColunas, env);

    // 3. Processar (o tempo/peça vem da descrição do card — parseTempoDescricao)
    const cards = processarCards(cardsRaw, mapaCols, {});

    // 4. Upsert no Supabase
    const total = await upsertSupabase(cards, env);

    // 5. Remove registros obsoletos (cards que saíram do escopo desde o último sync)
    const idsAtivos = cards.map(c => c.trello_id);
    const deletados = await limparObsoletos(idsAtivos, env);

    // 6. Histórico de movimentação — base do gráfico de vazão.
    //    Roda depois do upsert dos cards de propósito: se o teto de tempo da
    //    function for atingido aqui, os cards já estão salvos.
    //    Duas frentes por execução, ambas com teto de páginas:
    //      a) o que aconteceu desde a última movimentação gravada;
    //      b) backfill do passado, a partir da movimentação mais antiga gravada.
    //    Quando (b) satura, `mov_pendente` avisa que outro sync traz mais.
    let movimentacoes = 0;
    let movPendente = false;
    let movErro = null;
    try {
      const alvo = new Date(Date.now() - JANELA_INICIAL_DIAS * 24 * 3_600_000).toISOString();
      const lim  = await limitesMovimentacoes(env);
      let acoes = [];

      if (lim && lim.semTabela) {
        // Sem a tabela não adianta gastar chamadas no Trello.
        throw new Error("tabela `movimentacoes` não encontrada no Supabase — rode supabase_movimentacoes.sql no SQL Editor");
      }

      if (!lim || lim.vazia) {
        // Primeira carga: começa do presente e caminha para trás até o teto.
        const r = await buscarAcoesMovimentacao(env.TRELLO_BOARD_ID, env, alvo, null, MAX_PAGES_ACOES);
        acoes = r.acoes; movPendente = r.truncado;
      } else {
        // (a) novidades — 1 dia de sobreposição; o upsert deduplica por action_id
        const desde = new Date(new Date(lim.nova.data).getTime() - 24 * 3_600_000).toISOString();
        const novas = await buscarAcoesMovimentacao(env.TRELLO_BOARD_ID, env, desde, null, 2);
        acoes = novas.acoes;

        // (b) passado ainda não coberto
        if (new Date(lim.antiga.data).getTime() > new Date(alvo).getTime()) {
          const back = await buscarAcoesMovimentacao(env.TRELLO_BOARD_ID, env, alvo, lim.antiga.action_id, MAX_PAGES_ACOES);
          acoes = acoes.concat(back.acoes);
          movPendente = back.truncado;
        }
      }

      movimentacoes = await upsertMovimentacoes(processarMovimentacoes(acoes), env);
      console.log(`[sync] ${movimentacoes} movimentações gravadas${movPendente ? " — ainda há histórico anterior a importar" : ""}`);
    } catch (e) {
      movErro = e.message;
      console.warn("[sync] Movimentações não sincronizadas:", e.message);
    }

    const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
    console.log(`[sync] ${total} cards sincronizados, ${deletados} obsoletos removidos em ${duracao}s`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok:          true,
        total,
        deletados,
        movimentacoes,
        mov_pendente: movPendente,
        mov_erro:    movErro,
        colunas:     colunas.length,
        duracao_s:   parseFloat(duracao),
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
