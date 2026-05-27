# agents/pipeline/

Пост-ран пайплайн анализа. Запускается после завершения `main/agent.ts`. Обрабатывает собранные данные и строит реестр компонентов.

## Порядок выполнения

```
Шаги 2-4 — параллельно:
  aria-analyzer-agent    → analyzed/aria-components.json
  dom-analyzer-agent     → analyzed/dom-components.json
  network-analyzer-agent → analyzed/network-map.json

Шаг 5 — после шагов 2-4:
  identity-resolution-agent → registry/components.json
                               registry/pages.json
```

(Шаг 1 — сбор данных в `main/agent.ts` через `SessionCollector`)

## Файлы

### `pipeline-runner.ts` — класс `PipelineRunner`
Оркестратор пайплайна. Запускает шаги 2-4 параллельно, затем шаг 5 последовательно.

---

### `aria-analyzer-agent.ts` — класс `AriaAnalyzerAgent` (Шаг 2)
**Вход:** `raw/aria/*-aria.yaml`  
**Выход:** `analyzed/aria-components.json`  
Извлекает интерактивные ARIA-компоненты: ariaRole, ariaName, state (disabled/checked/expanded), context, pageUrl, stepId.

---

### `dom-analyzer-agent.ts` — класс `DomAnalyzerAgent` (Шаг 3)
**Вход:** `raw/dom/*-dom.html`  
**Выход:** `analyzed/dom-components.json`  
Извлекает атрибуты DOM-элементов для генерации селекторов: tagName, testid, cssSelector, id, name, type, text, ariaLabel, pageUrl, stepId.

---

### `network-analyzer-agent.ts` — класс `NetworkAnalyzerAgent` (Шаг 4)
**Вход:** `raw/network/*-network.json`  
**Выход:** `analyzed/network-map.json`  
Сопоставляет UI-взаимодействия с API-вызовами. Фильтрует шум (аналитика, CDN, шрифты). Обрабатывает батчами по 10 шагов.  
Поля: stepId, method, urlPattern, requestPayloadShape, expectedStatus, responseShape.

---

### `identity-resolution-agent.ts` — класс `IdentityResolutionAgent` (Шаг 5)
**Вход:** steps/*.json + три analyzed/*.json файла  
**Выход:** `registry/components.json`, `registry/pages.json`  
Ключевой агент: матчит «якоря» (интерактивные элементы) с ARIA/DOM/Network данными и строит реестр.

**Стратегия матчинга:**
- ARIA: строгий (role+name) → средний (только name) → LLM fallback
- DOM: строгий (testid) → средний (tagName+text или ariaLabel) → LLM fallback

**Уровни уверенности:** high, medium, low  
**Формат ID компонента:** `{pageSlug}__{componentSlug}` (макс. 80 символов)
