# Plano de Projeto — Análise do Quadro Trello 3D
**Quadro:** https://trello.com/b/7xdYwZjP/3d  
**Data:** Maio 2026  
**Escopo:** Todos os cards até a coluna **Montagem TQ Liberado/Feito**

---

## Legenda de Etiquetas (Referência)

| Cor da Etiqueta | Significado |
|---|---|
| 🟢 Verde | Coleção: Estação / Inv 27 |
| 🟠 Laranja | Estilista responsável |
| 🟡 Amarelo escuro | Coleção (marca/temporada) |
| Membro "Modelista Externo" | Trabalho freelancer |

### Tipos de Card
- **Montagem** — peça sendo montada
- **Novo** — peça nova
- **Ajuste** — peça em ajuste

---

## BLOCO 1 — Extração e Mapeamento dos Dados

### 1.1 Definir o escopo de colunas
- Mapear todas as colunas do quadro do início até **"Montagem TQ Liberado/Feito"** (inclusive)
- Listar os nomes exatos das colunas nesse intervalo para garantir precisão na extração

### 1.2 Extrair todos os cards dentro do escopo
- Capturar para cada card:
  - **Nome** do card
  - **Coluna** atual
  - **Tipo** (Montagem / Novo / Ajuste — identificado pelo nome ou etiqueta do card)
  - **Etiqueta Laranja** → nome da Estilista
  - **Etiqueta Amarelo Escuro** → nome da Coleção / Marca
  - **Etiqueta Verde** → se pertence a Estação|Inv 27
  - **Membros atribuídos** (incluindo identificar "Modelista Externo")
  - **Data de criação / movimentação** (se disponível — para cálculo de tempo)

### 1.3 Total geral de cards
- Contagem total de cards no escopo
- Distribuição por tipo: quantos são **Montagem**, **Novo** e **Ajuste**

---

## BLOCO 2 — Análise por Estilista

> Referência: **etiqueta laranja** = Estilista

### 2.1 Cards por Estilista
Para cada estilista identificada, contar:
- Total de cards
- Quantos são **Montagem**
- Quantos são **Novo**
- Quantos são **Ajuste**

### 2.2 Divisão por Coleção (dentro de cada Estilista)
> A mesma estilista pode estar em mais de uma coleção → usar **etiqueta amarelo escuro** para separar

Para cada combinação **Estilista × Coleção**:
- Total de cards
- Distribuição Montagem / Novo / Ajuste

### 2.3 Comparativo entre Estilistas
- Gráfico de barras: total de cards por estilista
- Gráfico empilhado: Montagem / Novo / Ajuste por estilista
- Identificar qual estilista tem maior volume e qual tipo predomina em cada uma

---

## BLOCO 3 — Análise por Marca

> Referência: **etiqueta amarelo escuro** → marca/coleção

Marcas identificadas: **Farm BR**, **GL**, **Maria Filó**, **Outras**

### 3.1 Total de Montagens por Marca
- Farm BR: X montagens
- GL: X montagens
- Maria Filó: X montagens
- Outras: X montagens

### 3.2 Total de Peças Novas por Marca
- Farm BR: X novos
- GL: X novos
- Maria Filó: X novos
- Outras: X novos

### 3.3 Total de Ajustes por Marca
- Farm BR: X ajustes
- GL: X ajustes
- Maria Filó: X ajustes
- Outras: X ajustes

### 3.4 Gráfico comparativo por marca
- Gráfico de barras agrupadas: Montagem / Novo / Ajuste para cada marca
- Percentual de participação de cada marca no total geral

---

## BLOCO 4 — Análise por Membro da Equipe

> Quem é responsável por cada card (membros atribuídos no Trello)

### 4.1 Montagens por membro
- Quantas montagens cada membro realizou
- Gráfico de barras

### 4.2 Ajustes por membro
- Quantos ajustes cada membro realizou
- Gráfico de barras

### 4.3 Novos por membro
- Quantas peças novas cada membro tratou
- Gráfico de barras

### 4.4 Visão consolidada por membro
- Tabela com os três tipos (Montagem / Novo / Ajuste) lado a lado para cada membro
- Identificar os membros com maior carga de trabalho total

---

## BLOCO 5 — Análise do Modelista Externo (Freelancer)

> Referência: membro com etiqueta/nome **"Modelista Externo"** = trabalho terceirizado

### 5.1 Participação do Modelista Externo
- Quantos cards estão atribuídos ao Modelista Externo
- Distribuição: Montagem / Novo / Ajuste
- Em quais coleções e marcas o Modelista Externo está presente

### 5.2 Comparativo Interno vs. Externo
- Percentual de cards que foram internos vs. terceirizados
- Gráfico de pizza: equipe interna × Modelista Externo
- Por marca: qual marca mais recorreu ao freelancer

---

## BLOCO 6 — Cálculo de Tempo e Complexidade

> Baseado na data de entrada e saída de cada card (se disponível no Trello)

### 6.1 Definição de Complexidade
| Nível | Tempo de Montagem |
|---|---|
| 🟢 Baixa | Até 1 hora |
| 🟡 Média | Até 2 horas |
| 🔴 Alta | Acima de 2 horas |

### 6.2 Classificação dos Cards
- Calcular o tempo médio de montagem por card (entrada na coluna de montagem → saída)
- Classificar cada card conforme a tabela acima
- Contar: quantos cards são de **complexidade baixa / média / alta**

### 6.3 Tempo médio por tipo
- Tempo médio de **Montagem**
- Tempo médio de **Novo**
- Tempo médio de **Ajuste**

### 6.4 Tempo médio por membro
- Qual membro tem maior/menor tempo médio por card

### 6.5 Gráfico de distribuição de complexidade
- Gráfico de pizza: distribuição de cards por nível de complexidade
- Por marca e por estilista: qual tem mais peças de alta complexidade

---

## BLOCO 7 — Saída e Entregáveis

### 7.1 Relatório HTML Interativo
- Dashboard visual com todos os gráficos e tabelas
- Filtros por marca, por estilista, por tipo de card e por membro
- Totalizadores no topo (cards totais, por tipo, por marca)

### 7.2 Planilha Excel (.xlsx) — Dados Brutos + Análises
- Aba 1: Dados brutos extraídos do Trello
- Aba 2: Resumo por estilista × coleção
- Aba 3: Resumo por marca
- Aba 4: Resumo por membro
- Aba 5: Análise Modelista Externo
- Aba 6: Cálculo de complexidade e tempo

### 7.3 Gráficos Principais a Gerar
1. Distribuição geral de cards: Montagem / Novo / Ajuste (pizza)
2. Cards por estilista, separados por tipo (barras empilhadas)
3. Cards por marca: Montagem / Novo / Ajuste (barras agrupadas)
4. Desempenho por membro: Montagem / Ajuste / Novo (barras)
5. Interno vs. Externo (pizza)
6. Distribuição de complexidade (pizza)
7. Tempo médio por tipo de card (barras)

---

## Fluxo de Execução

```
1. Acessar Trello via API ou navegador
2. Extrair todos os cards até "Montagem TQ Liberado/Feito"
3. Estruturar os dados em tabela (tipo, estilista, coleção, membro, datas)
4. Rodar análises dos Blocos 2 ao 6
5. Gerar gráficos
6. Montar relatório HTML + planilha Excel
7. Exportar entregáveis
```

---

## Perguntas a Confirmar Antes de Executar

- [ ] Os tipos (Montagem / Novo / Ajuste) estão no **nome do card** ou em uma **etiqueta específica**?
- [ ] A etiqueta amarelo escuro sempre indica a **marca** (Farm BR, GL, Maria Filó)? Ou há outros valores?
- [ ] As datas de movimentação entre colunas estão disponíveis (para cálculo de tempo)?
- [ ] Há cards que pertencem a mais de uma coleção ao mesmo tempo?
- [ ] O "Modelista Externo" é sempre um membro com esse nome exato, ou pode ter variações?
