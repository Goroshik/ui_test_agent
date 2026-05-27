# agents/dom-components/

Двухэтапный анализ UI-блоков из ARIA-снапшотов. Разбивает снапшот страницы на именованные компоненты и генерирует их описания.

## Файлы

### `types.ts`
Интерфейс `ComponentBlock`: `{ blockName: string, content: string }`.

---

### `hasher.ts` — `hashContent()`
MD5-хэш содержимого блока. Используется для дедупликации — блоки с одинаковым хэшем не перегенерируются.

---

### `splitter.ts` — класс `ComponentSplitter` (Этап 1)
LLM разбивает ARIA-снапшот на именованные UI-блоки (navbar, sidebar, main-content, footer и др.).  
Метод: `split(snapshot)` → `ComponentBlock[]`

---

### `analyzer.ts` — класс `ComponentAnalyzer` (Этап 2)
LLM генерирует человекочитаемое описание (3-5 предложений) для каждого блока.  
Метод: `describe(block)` → `string`

---

### `orchestrator.ts` — класс `ComponentOrchestrator`
Оркестрирует весь процесс split → analyze с оптимизациями:
1. Пропускает блоки с неизменённым хэшем
2. Переиспользует описания с других URL если контент идентичен
3. Сохраняет новые описания в БД (`dom-component-store`)

**Используется из:** `main/agent.ts` — после каждого снапшота страницы
