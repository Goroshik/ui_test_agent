# TODO: Agents Pipeline — сбор данных, сохранение, обновление

## Контекст
Система визуального регрессионного тестирования. Основной агент проходит по страницам,
собирает артефакты, которые потом используют специализированные агенты для анализа.

---

## Архитектура файлов данных

### Директории
```
./data/
  sessions/
    <sessionId>/          # одна сессия = один проход
      session-meta.json   # метаданные сессии
      steps/
        step-001.json     # данные одного шага
        step-002.json
        ...
      raw/
        aria/
          step-001-aria.yaml
        dom/
          step-001-dom.html
        network/
          step-001-network.json
        storage/
          step-001-storage.json
        screenshots/
          step-001.webp

./registry/
  components.json         # компонентный реестр (формируется Identity Agent)
  pages.json              # известные страницы и их компоненты
  selectors.json          # все известные селекторы (для быстрого lookup)
```

---

## Шаг 1: Main Navigator Agent

### Задача
Проходит по страницам согласно заданию, выполняет действия, на КАЖДОМ шаге собирает
и сохраняет артефакты ПЕРЕД и ПОСЛЕ действия.

### Что делать

#### 1.1 Инициализация сессии
При старте создать `session-meta.json`:
```json
{
  "sessionId": "<uuid>",
  "startedAt": "<ISO timestamp>",
  "task": "<строка задания>",
  "baseUrl": "<url>",
  "status": "running",
  "steps": []
}
```

#### 1.2 На каждом шаге — ПЕРЕД действием
Собрать и записать в `step-NNN.json`:
```json
{
  "stepId": "step-001",
  "stepIndex": 1,
  "timestamp": "<ISO>",
  "url": "<текущий url>",
  "action": {
    "type": "click | fill | navigate | select | hover",
    "description": "<что делаем и зачем>",
    "element": {
      "testid": "<data-testid если есть>",
      "ariaRole": "<role>",
      "ariaName": "<accessible name>",
      "tagName": "<tag>",
      "text": "<innerText если кнопка/ссылка>",
      "bbox": { "x": 0, "y": 0, "width": 0, "height": 0 },
      "xpath": "<xpath до элемента>",
      "cssPath": "<короткий css path>"
    },
    "value": "<значение для fill/select>"
  },
  "before": {
    "ariaSnapshotFile": "raw/aria/step-001-aria.yaml",
    "domFile": "raw/dom/step-001-dom.html",
    "storageFile": "raw/storage/step-001-storage.json",
    "screenshotFile": "raw/screenshots/step-001-before.webp"
  },
  "after": null
}
```

#### 1.3 Сбор ARIA snapshot (перед действием)
Использовать Playwright:
```javascript
// Получить aria snapshot всей страницы
const ariaSnapshot = await page.locator('body').ariaSnapshot();
// Записать в raw/aria/step-NNN-aria.yaml
```
ВАЖНО: ariaSnapshot() возвращает YAML-строку с деревом ролей, имён и состояний.
Это самый ценный источник для entity resolution.

#### 1.4 Сбор DOM snapshot (перед действием)
```javascript
// Сериализовать упрощённый DOM — только интерактивные элементы
const dom = await page.evaluate(() => {
  const selectors = [
    'button', 'a', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="tab"]',
    '[role="menuitem"]', '[data-testid]', '[aria-label]'
  ];
  return document.querySelectorAll(selectors.join(',')).map... // собрать атрибуты
});
```
Записать ТОЛЬКО интерактивные элементы, не весь HTML. Полный HTML — слишком большой.
Формат: минимальный HTML или JSON-массив элементов с атрибутами.

Атрибуты для каждого элемента:
- tagName, id, className, data-testid, aria-label, aria-role, name, type, value,
  placeholder, href, disabled, checked, textContent (первые 100 символов)

#### 1.5 Сбор Storage snapshot (перед действием)
Через CDP session:
```javascript
const client = await page.context().newCDPSession(page);

// localStorage
const storageData = await page.evaluate(() => ({
  localStorage: Object.fromEntries(
    Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])
  ),
  sessionStorage: Object.fromEntries(
    Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)])
  )
}));

// cookies
const cookies = await page.context().cookies();
```
Записать в `step-NNN-storage.json`.

#### 1.6 Network listener — включить ДО начала шага
```javascript
const networkEvents = [];
const requestHandler = (request) => {
  if (['xhr', 'fetch'].includes(request.resourceType())) {
    networkEvents.push({
      type: 'request',
      stepId: currentStepId,
      timestamp: Date.now(),
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      postData: request.postData()
    });
  }
};
const responseHandler = (response) => {
  if (['xhr', 'fetch'].includes(response.request().resourceType())) {
    networkEvents.push({
      type: 'response',
      stepId: currentStepId,
      timestamp: Date.now(),
      url: response.url(),
      status: response.status(),
      // body читать только если content-type json и size < 50kb
    });
  }
};
page.on('request', requestHandler);
page.on('response', responseHandler);
```

#### 1.7 Скриншот ПЕРЕД действием
```javascript
await page.screenshot({
  path: `raw/screenshots/step-NNN-before.webp`,
  type: 'webp',
  quality: 80
});
```

#### 1.8 ВЫПОЛНИТЬ ДЕЙСТВИЕ

#### 1.9 ПОСЛЕ действия — собрать diff
Ждём 500ms для завершения сетевых запросов, потом:

1. Скриншот после
2. Storage snapshot после
3. Вычислить storage diff:
```json
{
  "added": { "orderId": "123" },
  "changed": { "cartCount": { "from": "3", "to": "0" } },
  "removed": { "draftOrder": null }
}
```
4. Остановить network listener, сохранить события в `step-NNN-network.json`
5. Записать все собранные данные в поле `after` в `step-NNN.json`

#### 1.10 Обновить session-meta.json
Добавить шаг в массив `steps` с кратким описанием и статусом.

---

## Шаг 2: ARIA Analyzer Agent

### Задача
Читает все `step-NNN-aria.yaml` файлы и формирует список уникальных интерактивных
компонент, встреченных на сессии.

### Что делать

#### 2.1 Прочитать все aria файлы сессии
Пройтись по `sessions/<sessionId>/raw/aria/`.

#### 2.2 Промпт для LLM
Для каждого aria файла:
```
Ты анализируешь ARIA snapshot веб-страницы.
Извлеки список ВСЕХ интерактивных элементов.

Для каждого элемента верни JSON:
{
  "ariaRole": "button",
  "ariaName": "Checkout",
  "state": { "disabled": false, "checked": null, "expanded": null },
  "context": "inside form[name=cart]",
  "pageUrl": "<url из мета>",
  "stepId": "<stepId>"
}

Верни только JSON массив, без пояснений.
```

#### 2.3 Сохранить результат
Записать в `sessions/<sessionId>/analyzed/aria-components.json`.

---

## Шаг 3: DOM Analyzer Agent

### Задача
Читает DOM snapshot файлы, извлекает элементы с их атрибутами.

#### 3.1 Промпт для LLM
```
Ты анализируешь DOM snapshot веб-страницы. Дан список интерактивных элементов.
Для каждого элемента извлеки:
{
  "tagName": "button",
  "testid": "checkout-btn",
  "cssSelector": ".btn-primary",
  "id": null,
  "name": null,
  "type": "submit",
  "text": "Checkout",
  "ariaLabel": "Proceed to checkout",
  "pageUrl": "<url>",
  "stepId": "<stepId>"
}
Верни только JSON массив.
```

#### 3.2 Сохранить
Записать в `sessions/<sessionId>/analyzed/dom-components.json`.

---

## Шаг 4: Network Analyzer Agent

### Задача
Читает network логи и строит карту: какой UI элемент → какой API вызов.

#### 4.1 Промпт для LLM
```
Дан лог сетевых запросов сессии. Каждый запрос имеет stepId.
Для каждого шага определи:
{
  "stepId": "step-007",
  "triggers": [
    {
      "method": "POST",
      "urlPattern": "/api/checkout",
      "requestPayloadShape": { "cartId": "string", "items": "array" },
      "expectedStatus": 200,
      "responseShape": { "orderId": "string", "total": "number" }
    }
  ]
}
Верни только JSON массив.
```

#### 4.2 Сохранить
Записать в `sessions/<sessionId>/analyzed/network-map.json`.

---

## Шаг 5: Identity Resolution Agent

### Задача
Объединить записи из трёх источников в единые ComponentRecord.
Подробное описание — в файле TODO-2-entity-resolution.md.

#### 5.1 Input файлы
- `analyzed/aria-components.json`
- `analyzed/dom-components.json`
- `analyzed/network-map.json`
- `steps/step-NNN.json` (для element fingerprint из `action.element`)

#### 5.2 Output
Обновить `registry/components.json` — добавить новые компоненты, обновить существующие.

### Логика обновления реестра (ВАЖНО)
- Если компонент уже есть в реестре (совпадение по stable ID) — MERGE, не перезапись
- При merge: добавлять новые selectors, не удалять существующие
- Поле `confidence` повышать при каждом подтверждении
- Поле `lastSeen` всегда обновлять
- Поле `manualOverride: true` — не трогать автоматически НИКОГДА

---

## Форматы файлов реестра

### registry/components.json
```json
{
  "version": "1.0",
  "lastUpdated": "<ISO>",
  "components": {
    "cart-page__checkout-btn": { /* ComponentRecord */ },
    "global__header-logo": { /* ComponentRecord */ }
  }
}
```

### registry/pages.json
```json
{
  "/cart": {
    "title": "Shopping Cart",
    "components": ["cart-page__checkout-btn", "cart-page__quantity-input"],
    "lastSeen": "<ISO>"
  }
}
```

---

## Важные принципы

1. **Атомарность шага**: все файлы одного шага пишутся вместе. Если агент упал посередине —
   шаг помечается как `status: incomplete` и не используется для анализа.

2. **Идемпотентность**: повторный запуск агентов на тех же файлах не должен дублировать
   записи в реестре.

3. **Не удалять старые данные**: сессии накапливаются. Удаление только руками.

4. **Размер файлов**: DOM snapshot не должен превышать 100KB. Если больше — обрезать до
   первых 200 интерактивных элементов и записать `truncated: true`.

5. **Таймауты**: после каждого действия ждать MIN(networkIdle, 2000ms) перед сбором after-данных.
