# TODO: Entity Resolution — как понять что это один и тот же компонент

## Проблема
Три источника (ARIA, DOM, Network) описывают одни и те же элементы разным языком.
Нужно надёжно склеить их в одну запись ComponentRecord.

Пример: один элемент описан так в трёх источниках:
- ARIA:    `button[name="Checkout"]`
- DOM:     `<button data-testid="checkout-btn" class="btn-primary">`
- Network: `step-007 → POST /api/checkout`

---

## Алгоритм Identity Resolution

### Этап 1: Anchor Matching (детерминированный, без LLM)

Основная идея: в `step-NNN.json` записан `action.element` — fingerprint элемента
в момент взаимодействия. Это единственная запись где точно известно ЧТО за элемент
вызвал сетевые события.

#### 1.1 Построить anchor index
Для каждого шага собрать anchor:
```javascript
const anchor = {
  stepId: step.stepId,
  testid: step.action.element.testid,       // "checkout-btn"
  ariaRole: step.action.element.ariaRole,   // "button"
  ariaName: step.action.element.ariaName,   // "Checkout"
  tagName: step.action.element.tagName,     // "button"
  text: step.action.element.text,           // "Checkout"
  bbox: step.action.element.bbox            // {x, y, w, h}
};
```

#### 1.2 Сопоставить с ARIA snapshot
Искать в `aria-components.json` запись где `stepId == anchor.stepId` И одно из:
- `ariaRole == anchor.ariaRole` + `ariaName == anchor.ariaName` → STRONG MATCH
- только `ariaName == anchor.ariaName` → WEAK MATCH

#### 1.3 Сопоставить с DOM snapshot
Искать в `dom-components.json` запись где `stepId == anchor.stepId` И одно из:
- `testid == anchor.testid` (если testid не null) → STRONG MATCH
- `tagName == anchor.tagName` + `text == anchor.text` → MEDIUM MATCH
- `ariaLabel == anchor.ariaName` → MEDIUM MATCH

#### 1.4 Сопоставить с Network
Искать в `network-map.json` запись где `stepId == anchor.stepId` → прямое совпадение.
(Сетевые события уже привязаны к stepId при сборе.)

---

### Этап 2: Canonical ID Generation

После сопоставления нужно создать стабильный ID компонента для реестра.

#### Правило генерации canonical ID
Формат: `<page-slug>__<component-slug>`

```javascript
function generateCanonicalId(anchor, url) {
  // page slug: /cart → "cart", /products/123 → "products-detail"
  const pageSlug = urlToSlug(url);

  // component slug: приоритет testid > ariaName > text
  const componentSlug = anchor.testid
    ? kebabCase(anchor.testid)
    : anchor.ariaName
      ? kebabCase(anchor.ariaName)
      : `${anchor.tagName}-${hashShort(anchor.bbox)}`;

  return `${pageSlug}__${componentSlug}`;
}
```

Примеры:
- `/cart` + testid `checkout-btn` → `cart__checkout-btn`
- `/` + ariaName `Open menu` → `home__open-menu`
- `/products` + button без id → `products__button-a3f2`

---

### Этап 3: LLM Merge Agent (для неоднозначных случаев)

Запускать LLM только когда детерминированный алгоритм не дал STRONG MATCH.

#### 3.1 Промпт для LLM разрешения неоднозначностей

```
Ты агент сопоставления UI компонентов.

Дан anchor (элемент из шага взаимодействия):
<anchor_json>

Дан список кандидатов из ARIA snapshot этого шага:
<aria_candidates_json>

Дан список кандидатов из DOM snapshot этого шага:
<dom_candidates_json>

Твоя задача: определить, какой кандидат из ARIA и какой из DOM описывают тот же
элемент что и anchor.

Правила:
1. Если не уверен — укажи confidence: "low" и объясни почему.
2. Если кандидатов нет — верни null.
3. Не угадывай. Лучше null чем неправильный match.

Верни JSON:
{
  "ariaMatch": { "index": 0, "confidence": "high|medium|low" },
  "domMatch": { "index": 2, "confidence": "high|medium|low" },
  "reasoning": "кратко почему"
}
```

#### 3.2 Когда НЕ запускать LLM
- Если на странице только 1 кандидат с нужной ролью → брать автоматически
- Если testid совпал → брать автоматически
- Если общий confidence уже "high" → не тратить токены

---

### Этап 4: Формирование ComponentRecord

После успешного сопоставления собрать итоговую запись.

#### 4.1 Структура ComponentRecord

```typescript
interface ComponentRecord {
  // IDENTITY
  id: string;                    // "cart__checkout-btn"
  label: string;                 // "Checkout button" (human readable)
  componentType: string;         // "button" | "input" | "link" | "form" | "modal" | etc

  // WHERE
  pages: string[];               // ["/cart", "/checkout/step1"] — на каких страницах встречался
  lastSeen: string;              // ISO timestamp

  // HOW TO SELECT (в порядке надёжности)
  selectors: {
    preferred: string;           // лучший селектор для Cypress
    aria: string;                // "button[name='Checkout']"
    testid: string | null;       // "[data-testid='checkout-btn']"
    css: string | null;          // ".btn-primary.checkout-button"
    xpath: string | null;        // только как последний fallback
  };

  // WHAT IT DOES
  actions: ComponentAction[];

  // STATES
  states: {
    disabled_when?: string;      // "cart is empty"
    hidden_when?: string;        // "user not logged in"
    loading_after?: string;      // "after click, ~500ms"
    variants?: string[];         // ["default", "loading", "disabled"]
  };

  // ASSERTIONS (что проверять после взаимодействия)
  assertions: {
    pre_interaction: string[];   // ["be.visible", "be.enabled"]
    post_interaction: string[];  // ["url include /confirmation", "network 200"]
  };

  // META
  confidence: "high" | "medium" | "low";
  seenCount: number;             // сколько раз встречался
  manualOverride: boolean;       // true = не трогать автоматически
  notes: string;                 // место для ручных заметок
}

interface ComponentAction {
  type: "click" | "fill" | "select" | "hover" | "focus";
  value?: string;                // для fill/select

  // Network side effects
  network?: {
    method: string;              // "POST"
    urlPattern: string;          // "/api/checkout" или regex
    requestShape?: object;       // примерная форма payload
    expectedStatus: number;      // 200
    responseShape?: object;      // примерная форма ответа
  };

  // Storage side effects
  storageDiff?: {
    localStorage?: { added?: object; changed?: object; removed?: string[] };
    cookies?: { added?: object; removed?: string[] };
  };

  // Navigation side effects
  navigation?: {
    to: string;                  // "/confirmation" или "same page"
    condition?: string;          // "on success"
  };
}
```

---

### Этап 5: Merge Strategy (обновление существующей записи)

Когда компонент уже есть в реестре и мы нашли его снова:

#### 5.1 Правила merge

```javascript
function mergeComponentRecord(existing, newData) {
  // НИКОГДА не трогать если manualOverride
  if (existing.manualOverride) return existing;

  return {
    ...existing,

    // pages: union
    pages: [...new Set([...existing.pages, ...newData.pages])],

    // selectors: добавлять новые, не удалять старые
    selectors: {
      preferred: existing.selectors.preferred, // не менять preferred автоматически
      aria: newData.selectors.aria || existing.selectors.aria,
      testid: existing.selectors.testid || newData.selectors.testid,
      css: existing.selectors.css || newData.selectors.css,
      xpath: existing.selectors.xpath || newData.selectors.xpath,
    },

    // actions: добавлять новые паттерны, не дублировать
    actions: mergeActions(existing.actions, newData.actions),

    // states: merge объектов
    states: { ...existing.states, ...newData.states },

    // assertions: union
    assertions: {
      pre_interaction: [...new Set([
        ...existing.assertions.pre_interaction,
        ...newData.assertions.pre_interaction
      ])],
      post_interaction: [...new Set([
        ...existing.assertions.post_interaction,
        ...newData.assertions.post_interaction
      ])],
    },

    // meta: обновить
    confidence: upgradeConfidence(existing.confidence, newData.confidence),
    seenCount: existing.seenCount + 1,
    lastSeen: new Date().toISOString(),
  };
}
```

#### 5.2 Как mergeActions
Две actions считаются дублями если совпадают `type` + `network.urlPattern`.
Если дубль — взять с более высоким confidence, остальные поля merge.

---

### Этап 6: Preferred Selector Logic

Определить `selectors.preferred` для Cypress — самый надёжный.

#### Приоритет:
1. `[data-testid="..."]` — если есть, всегда предпочтительнее
2. `[aria-label="..."]` — если уникален на странице
3. `role + name` через `cy.findByRole` (testing-library) — семантически стабилен
4. `#id` — только если id не динамический (не `input-1234-abc`)
5. `.class` — только если класс явно семантический, не утилитарный
6. `xpath` — только как последний резорт

#### Проверка уникальности (через DOM snapshot)
```javascript
// Считать сколько элементов матчит селектор на странице
// Если > 1 — не использовать как preferred, искать более специфичный
```

---

### Итог: что делает Identity Resolution Agent пошагово

```
1. Прочитать все step-NNN.json → построить anchor index
2. Прочитать aria-components.json, dom-components.json, network-map.json
3. Для каждого anchor:
   a. Детерминированный матчинг по stepId + strong signals
   b. Если неоднозначно → LLM разрешение
   c. Генерировать canonical ID
   d. Собрать ComponentRecord из всех источников
   e. Определить preferred selector
4. Прочитать registry/components.json
5. Для каждого нового ComponentRecord:
   a. Если ID уже есть → merge по правилам выше
   b. Если новый → добавить
6. Записать обновлённый registry/components.json
7. Обновить registry/pages.json
8. Вывести отчёт: добавлено N, обновлено M, конфликтов K
```
