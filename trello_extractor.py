"""
trello_extractor.py
===================
Extrai dados reais do quadro Trello 3D e envia ao Supabase.

Uso:
    python trello_extractor.py

O script salva os dados em dois lugares:
  1. data.json   → arquivo local para testes do dashboard
  2. Supabase    → banco de dados para o dashboard em produção (Netlify)

Requisitos:
    pip install requests supabase python-dotenv

Configuração:
    Edite as variáveis na seção CONFIG abaixo ou crie um arquivo .env
"""

import requests
import json
import os
from datetime import datetime, timezone
from collections import defaultdict

# ──────────────────────────────────────────────
# CONFIG — edite aqui ou use variáveis de ambiente
# ──────────────────────────────────────────────

TRELLO_API_KEY  = os.getenv("TRELLO_API_KEY",  "")   # defina no .env
TRELLO_TOKEN    = os.getenv("TRELLO_TOKEN",     "")   # defina no .env
BOARD_ID        = os.getenv("TRELLO_BOARD_ID",  "7xdYwZjP")

# Coluna limite — análise vai até esta coluna (inclusive)
TARGET_COLUMN   = "Montagem TQ Liberado/Feito"

# Supabase — preencha após criar seu projeto em supabase.com
SUPABASE_URL    = os.getenv("SUPABASE_URL",  "https://rvwatkeyjnbqnxkwadwo.supabase.co")
# ⚠️  Use a SERVICE ROLE KEY aqui (não a anon key) para ter permissão de escrita.
# Copie em: supabase.com → projeto → Settings → API → service_role key
SUPABASE_KEY    = os.getenv("SUPABASE_KEY",  "COLE_SUA_SERVICE_ROLE_KEY_AQUI")

# Mapeamento de cores de etiqueta Trello
COR_ESTILISTA   = "orange"                          # 🟠 Estilista
CORES_COLECAO   = ["yellow", "yellow_dark"]         # 🟡 Coleção / Marca
COR_INV27       = "green"                           # 🟢 Estação | Inv 27

# Marcas conhecidas (identificadas pelo texto da etiqueta amarela)
MARCAS = ["Farm BR", "GL", "Maria Filó"]
NOME_FREELANCER = "Modelista Externo"

# Ativar cálculo de tempo (requer chamadas extras à API — mais lento)
CALCULAR_TEMPO  = True

# ──────────────────────────────────────────────
# HELPERS DE API
# ──────────────────────────────────────────────

def trello_get(endpoint: str, params: dict = {}) -> list | dict:
    """Faz GET na API do Trello com tratamento de erros."""
    base = {"key": TRELLO_API_KEY, "token": TRELLO_TOKEN}
    url  = f"https://api.trello.com/1{endpoint}"
    resp = requests.get(url, params={**base, **params}, timeout=30)
    resp.raise_for_status()
    return resp.json()


def paginar_acoes(endpoint: str, params: dict = {}) -> list:
    """
    Busca ações com paginação automática (máx 1000 por página).
    Necessário para quadros com muita movimentação.
    """
    todas = []
    pagina_params = {**params, "limit": 1000}

    while True:
        resultados = trello_get(endpoint, pagina_params)
        if not resultados:
            break
        todas.extend(resultados)
        if len(resultados) < 1000:
            break
        # Próxima página: antes do último ID recebido
        pagina_params["before"] = resultados[-1]["id"]

    return todas


# ──────────────────────────────────────────────
# EXTRAÇÃO DO TRELLO
# ──────────────────────────────────────────────

def buscar_colunas() -> list[dict]:
    """
    Busca todas as colunas abertas do quadro e retorna
    apenas aquelas até (e incluindo) TARGET_COLUMN.
    """
    todas = trello_get(f"/boards/{BOARD_ID}/lists", {"filter": "open"})
    escopo = []
    for col in todas:
        escopo.append(col)
        if col["name"].strip() == TARGET_COLUMN.strip():
            break
    else:
        # Coluna alvo não encontrada — avisa mas continua com todas
        print(f"⚠️  Coluna '{TARGET_COLUMN}' não encontrada. Usando todas as colunas.")
        return todas

    print(f"📋 {len(escopo)} colunas no escopo (até '{TARGET_COLUMN}'):")
    for c in escopo:
        print(f"     • {c['name']}")
    return escopo


def buscar_cards(ids_colunas: set[str]) -> list[dict]:
    """Busca todos os cards abertos do quadro e filtra pelas colunas do escopo."""
    todos = trello_get(f"/boards/{BOARD_ID}/cards", {
        "fields":        "id,name,idList,labels,dateLastActivity,due,dueComplete",
        "members":       "true",
        "member_fields": "fullName,username",
        "filter":        "open",
    })
    filtrados = [c for c in todos if c["idList"] in ids_colunas]
    print(f"🃏 {len(filtrados)} cards encontrados no escopo")
    return filtrados


def buscar_acoes_movimentacao() -> dict[str, list[dict]]:
    """
    Busca todas as ações de movimentação de cards (updateCard:idList) do quadro.
    Retorna dicionário: {card_id → [lista de ações em ordem cronológica]}
    """
    print("⏳ Buscando histórico de movimentações (pode demorar)...")
    acoes = paginar_acoes(f"/boards/{BOARD_ID}/actions", {
        "filter": "updateCard:idList",
    })

    por_card = defaultdict(list)
    for a in acoes:
        card_id = a.get("data", {}).get("card", {}).get("id")
        if card_id:
            por_card[card_id].append(a)

    # Ordenar cada lista por data crescente
    for card_id in por_card:
        por_card[card_id].sort(key=lambda x: x["date"])

    print(f"📅 {len(acoes)} movimentações encontradas para {len(por_card)} cards")
    return dict(por_card)


# ──────────────────────────────────────────────
# DETECÇÃO DE ATRIBUTOS
# ──────────────────────────────────────────────

def detectar_tipo(card: dict) -> str:
    """Detecta o tipo do card (Montagem / Novo / Ajuste) via etiquetas e nome."""
    # 1. Verifica etiquetas
    for label in card.get("labels", []):
        nome = label.get("name", "").strip().lower()
        if "montagem" in nome:    return "Montagem"
        if "novo"    in nome or "nova" in nome: return "Novo"
        if "ajuste"  in nome:     return "Ajuste"
    # 2. Fallback: nome do card
    nome_card = card.get("name", "").lower()
    if "montagem" in nome_card:   return "Montagem"
    if "novo"     in nome_card or "nova" in nome_card: return "Novo"
    if "ajuste"   in nome_card:   return "Ajuste"
    return "Outro"


def detectar_estilista(card: dict) -> str:
    """Retorna o nome da estilista (etiqueta laranja)."""
    for label in card.get("labels", []):
        if label.get("color") == COR_ESTILISTA:
            return label.get("name", "").strip() or "Sem Nome"
    return "Sem Estilista"


def detectar_colecao_e_marca(card: dict) -> tuple[str, str]:
    """
    Retorna (nome_da_coleção, nome_da_marca) com base na etiqueta amarela.
    A marca é inferida do texto da coleção.
    """
    for label in card.get("labels", []):
        if label.get("color") in CORES_COLECAO:
            texto = label.get("name", "").strip()
            marca = "Outras"
            for m in MARCAS:
                if m.lower() in texto.lower():
                    marca = m
                    break
            return texto or "Sem Coleção", marca
    return "Sem Coleção", "Outras"


def detectar_inv27(card: dict) -> bool:
    """Retorna True se o card tiver a etiqueta verde (Estação | Inv 27)."""
    for label in card.get("labels", []):
        if label.get("color") == COR_INV27:
            return True
    return False


def detectar_freelancer(card: dict) -> bool:
    """Retorna True se 'Modelista Externo' for membro do card."""
    for membro in card.get("members", []):
        nome = membro.get("fullName", "") or membro.get("username", "")
        if NOME_FREELANCER.lower() in nome.lower():
            return True
    return False


def listar_membros(card: dict) -> list[str]:
    """Retorna lista de nomes completos dos membros do card."""
    return [
        m.get("fullName") or m.get("username", "Desconhecido")
        for m in card.get("members", [])
    ]


# ──────────────────────────────────────────────
# CÁLCULO DE TEMPO
# ──────────────────────────────────────────────

def calcular_tempo_na_montagem(
    card_id: str,
    acoes_por_card: dict,
    nomes_colunas_montagem: set[str],
) -> float | None:
    """
    Calcula o tempo (em horas) que o card ficou em colunas relacionadas
    à montagem, usando o histórico de movimentações.

    Retorna None se não houver dados suficientes.
    """
    acoes = acoes_por_card.get(card_id, [])
    if not acoes:
        return None

    tempo_total = 0.0
    entrada_montagem = None

    for acao in acoes:
        lista_antes = acao.get("data", {}).get("listBefore", {}).get("name", "")
        lista_depois = acao.get("data", {}).get("listAfter",  {}).get("name", "")
        data_acao   = datetime.fromisoformat(acao["date"].replace("Z", "+00:00"))

        # Card entrou numa coluna de montagem
        if any(kw in lista_depois.lower() for kw in ["montagem", "montar"]):
            if entrada_montagem is None:
                entrada_montagem = data_acao

        # Card saiu de uma coluna de montagem
        if entrada_montagem and any(kw in lista_antes.lower() for kw in ["montagem", "montar"]):
            delta = (data_acao - entrada_montagem).total_seconds() / 3600
            tempo_total += delta
            entrada_montagem = None

    # Card ainda está em montagem (sem saída registrada)
    if entrada_montagem:
        agora = datetime.now(timezone.utc)
        delta = (agora - entrada_montagem).total_seconds() / 3600
        tempo_total += delta

    return round(tempo_total, 2) if tempo_total > 0 else None


def classificar_complexidade(horas: float | None) -> str:
    """Classifica a complexidade com base no tempo de montagem."""
    if horas is None:
        return "Não calculado"
    if horas <= 1:
        return "Baixa"
    if horas <= 2:
        return "Média"
    return "Alta"


# ──────────────────────────────────────────────
# PROCESSAMENTO PRINCIPAL
# ──────────────────────────────────────────────

def processar_cards(
    cards: list[dict],
    mapa_colunas: dict[str, str],
    acoes_por_card: dict,
) -> list[dict]:
    """Transforma os cards brutos do Trello em registros estruturados."""
    processados = []

    for card in cards:
        colecao, marca = detectar_colecao_e_marca(card)
        membros        = listar_membros(card)
        tipo           = detectar_tipo(card)

        # Tempo e complexidade
        if CALCULAR_TEMPO and acoes_por_card:
            nomes_montagem = {v for v in mapa_colunas.values()
                              if "montagem" in v.lower() or "montar" in v.lower()}
            tempo_h = calcular_tempo_na_montagem(card["id"], acoes_por_card, nomes_montagem)
        else:
            tempo_h = None

        complexidade = classificar_complexidade(tempo_h)

        processados.append({
            "trello_id":            card["id"],
            "nome":                 card.get("name", ""),
            "coluna":               mapa_colunas.get(card["idList"], "Desconhecida"),
            "tipo":                 tipo,
            "estilista":            detectar_estilista(card),
            "colecao":              colecao,
            "marca":                marca,
            "membros":              membros,         # lista de strings
            "is_modelista_externo": detectar_freelancer(card),
            "is_inv27":             detectar_inv27(card),
            "tempo_horas":          tempo_h,
            "complexidade":         complexidade,
            "data_atividade":       card.get("dateLastActivity"),
            "extraido_em":          datetime.now(timezone.utc).isoformat(),
        })

    return processados


# ──────────────────────────────────────────────
# SAÍDAS: JSON LOCAL + SUPABASE
# ──────────────────────────────────────────────

def salvar_json(cards: list[dict], caminho: str = "data.json") -> None:
    """Salva os dados processados em um arquivo JSON local."""
    with open(caminho, "w", encoding="utf-8") as f:
        json.dump(
            {"cards": cards, "gerado_em": datetime.now(timezone.utc).isoformat()},
            f, ensure_ascii=False, indent=2,
        )
    print(f"💾 {len(cards)} cards salvos em '{caminho}'")


def enviar_supabase(cards: list[dict]) -> None:
    """
    Faz upsert dos cards no Supabase.
    Requer: pip install supabase
    """
    if SUPABASE_URL == "SUA_URL_SUPABASE_AQUI":
        print("⚠️  Supabase não configurado — pulando envio ao banco.")
        print("    Configure SUPABASE_URL e SUPABASE_KEY para habilitar.")
        return

    try:
        from supabase import create_client
    except ImportError:
        print("⚠️  Biblioteca supabase não instalada.")
        print("    Execute: pip install supabase")
        return

    print("☁️  Enviando dados ao Supabase...")
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    # Serializa membros como JSON string para o banco
    registros = []
    for c in cards:
        r = {**c}
        r["membros"] = json.dumps(c["membros"], ensure_ascii=False)
        registros.append(r)

    # Upsert em lotes de 100
    LOTE = 100
    for i in range(0, len(registros), LOTE):
        lote = registros[i:i + LOTE]
        sb.table("cards").upsert(lote, on_conflict="trello_id").execute()
        print(f"   ✅ Lote {i // LOTE + 1}: {len(lote)} cards")

    print(f"🚀 {len(registros)} cards no Supabase!")


def imprimir_resumo(cards: list[dict]) -> None:
    """Imprime um resumo no terminal após a extração."""
    print("\n" + "═" * 50)
    print("  RESUMO DA EXTRAÇÃO")
    print("═" * 50)
    print(f"  Total de cards:     {len(cards)}")

    contagem_tipo = defaultdict(int)
    contagem_marca = defaultdict(int)
    for c in cards:
        contagem_tipo[c["tipo"]] += 1
        contagem_marca[c["marca"]] += 1

    print("\n  Por tipo:")
    for tipo, qtd in sorted(contagem_tipo.items(), key=lambda x: -x[1]):
        print(f"     {tipo:<15} {qtd:>4}")

    print("\n  Por marca:")
    for marca, qtd in sorted(contagem_marca.items(), key=lambda x: -x[1]):
        print(f"     {marca:<20} {qtd:>4}")

    freelancers = sum(1 for c in cards if c["is_modelista_externo"])
    inv27       = sum(1 for c in cards if c["is_inv27"])
    print(f"\n  Modelista Externo:  {freelancers}")
    print(f"  Estação | Inv 27:   {inv27}")
    print("═" * 50 + "\n")


# ──────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────

def main():
    print("\n🔄 Iniciando extração do Trello...\n")

    # 1. Colunas no escopo
    colunas   = buscar_colunas()
    ids_cols  = {c["id"] for c in colunas}
    mapa_cols = {c["id"]: c["name"] for c in colunas}

    # 2. Cards
    cards_brutos = buscar_cards(ids_cols)

    # 3. Histórico de movimentações (opcional)
    acoes = {}
    if CALCULAR_TEMPO:
        acoes = buscar_acoes_movimentacao()

    # 4. Processar
    cards = processar_cards(cards_brutos, mapa_cols, acoes)

    # 5. Resumo no terminal
    imprimir_resumo(cards)

    # 6. Salvar localmente
    salvar_json(cards)

    # 7. Enviar ao Supabase
    enviar_supabase(cards)

    print("✅ Extração concluída!\n")


if __name__ == "__main__":
    main()
