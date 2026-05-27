# pipeline/

Слой файловой персистентности — заменяет MongoDB. Содержит типы, хранилища данных и коллектор сессий.

## Файлы

### `types.ts`
Все TypeScript-типы для пайплайна. Никаких зависимостей — только интерфейсы.

Ключевые типы:
| Тип | Что описывает |
|-----|--------------|
| `SessionMeta` | Метаданные сессии (id, task, baseUrl, status, шаги) |
| `StepRecord` | Полная запись шага: URL, действие, артефакты до/после, статус |
| `ActionData` | Описание действия: тип, элемент, значение |
| `ArtifactRefs` | Ссылки на файлы артефактов (ARIA, DOM, network, storage, screenshot) |
| `StorageDiff` | Изменения в storage (added/changed/removed) |
| `AriaComponent` | ARIA-компонент после анализа (role, name, state, context) |
| `DomComponent` | DOM-компонент (tag, testid, css, id, text, ariaLabel) |
| `NetworkTrigger` | Паттерн сетевого запроса (method, urlPattern, shapes) |
| `ComponentRecord` | Запись в реестре компонентов (id, selectors, actions, states, confidence) |
| `ComponentRegistry` | Весь реестр компонентов |
| `PageRegistry` | Маппинг URL → метаданные страницы + список компонентов |

---

### `session-collector.ts` — класс `SessionCollector`
Управляет файловой структурой одной сессии: создаёт директории, сохраняет шаги и артефакты.

**Использование в `main/agent.ts`:** создаётся при старте сессии, метод `beginStep()`/`completeStep()` вызывается на каждом шаге.

**Создаваемая структура:**
```
sessions/{sessionId}/
├── session-meta.json         ← статус сессии + сводка шагов
├── steps/
│   ├── step-001.json         ← полная запись каждого шага
│   └── ...
├── analyzed/                 ← сюда пишут агенты pipeline/
└── raw/
    ├── aria/                 ← step-NNN-aria.yaml
    ├── dom/                  ← step-NNN-dom.html
    ├── network/              ← step-NNN-network.json
    ├── storage/              ← step-NNN-storage.json
    └── screenshots/          ← step-NNN-{before|after}.webp
```

**Ключевые методы:**
- `init(task, baseUrl)` — создаёт директории, пишет session-meta.json
- `nextStepId()` → `"step-001"`, `"step-002"` ...
- `beginStep()` / `completeStep()` — жизненный цикл шага
- `saveAriaSnapshot()`, `saveDomSnapshot()`, `saveNetwork()`, `saveStorage()`, `saveScreenshot()` — запись артефактов
- `finishSession(status)` — финализация сессии

---

### `dom-component-store.ts`
Файловое хранилище описаний DOM-блоков. Заменяет коллекцию MongoDB `components`.

**Файл данных:** `data/dom-components.json`  
**Структура:** `URL → blockName → { blockName, contentHash, description, analyzedAt }`

**Экспорты:**
- `upsertComponent(doc)` — создать/обновить компонент
- `getComponent(url, blockName)` — получить по URL + имени блока
- `findComponentByHash(contentHash)` — найти по хэшу (кросс-URL дедупликация)
- `getComponentsByUrl(url)` — все компоненты страницы

**Используется из:** `agents/dom-components/orchestrator.ts`

---

### `content-summary-store.ts`
Файловый кэш AI-описаний контента (скриншоты, снапшоты).

**Файл данных:** `data/content-summaries.json`  
**Ключ:** `"{key}__{kind}"` → текст описания

**Экспорты:**
- `getContentSummary(key, kind)` → `string | null`
- `upsertContentSummary(key, kind, summary)` → `void`

---

## Файлы данных (создаются в рантайме)

```
data/
├── content-summaries.json
└── dom-components.json

sessions/
└── {sessionId}/
    └── ... (см. SessionCollector выше)
```
