# TODO: Генерация Cypress тестов из компонентного реестра

## Концепция
Тест-генератор читает ComponentRecord из реестра и session steps,
и генерирует полноценные Cypress тесты. Реестр — единственный источник правды
для селекторов и assertions.

---

## Архитектура Test Generator Agent

### Input
- `registry/components.json` — компонентный реестр
- `sessions/<id>/steps/step-NNN.json` — шаги сессии (для сценария)
- `sessions/<id>/analyzed/network-map.json` — network эффекты

### Output
- `cypress/e2e/<page-name>/<test-name>.cy.js` — сгенерированные тесты
- `cypress/support/selectors.js` — централизованный файл селекторов
- `cypress/fixtures/<component-id>.json` — фикстуры для network mock

---

## Шаг 1: Сгенерировать cypress/support/selectors.js

Это самый важный файл. Все тесты берут селекторы ТОЛЬКО отсюда.
При изменении реестра — регенерировать этот файл → все тесты автоматически обновятся.

### Формат файла selectors.js
```javascript
// АВТОГЕНЕРИРОВАННЫЙ ФАЙЛ — не редактировать вручную
// Источник: registry/components.json
// Последнее обновление: <timestamp>
//
// Для ручных правок: отредактируй registry/components.json
// и запусти npm run generate:selectors

export const SELECTORS = {
  // Страница: /cart
  CART: {
    CHECKOUT_BTN: '[data-testid="checkout-btn"]',          // confidence: high
    QUANTITY_INPUT: '[data-testid="quantity-input"]',      // confidence: high
    REMOVE_ITEM_BTN: '[aria-label="Remove item"]',         // confidence: medium
    CART_TOTAL: '[data-testid="cart-total"]',              // confidence: high
    EMPTY_STATE: '[data-testid="empty-cart-message"]',     // confidence: medium
  },

  // Страница: /
  HOME: {
    HEADER_LOGO: '[data-testid="header-logo"]',
    NAV_CART_LINK: '[aria-label="Cart (3 items)"]',        // NOTE: динамический aria-name
    SEARCH_INPUT: '[data-testid="search-input"]',
  },

  // Глобальные (встречаются на многих страницах)
  GLOBAL: {
    LOADING_SPINNER: '[data-testid="loading-spinner"]',
    ERROR_TOAST: '[role="alert"]',
    MODAL_OVERLAY: '[role="dialog"]',
    CONFIRM_BTN: '[data-testid="confirm-btn"]',
    CANCEL_BTN: '[data-testid="cancel-btn"]',
  }
};

// Хелперы для динамических компонентов
export const getCartItemSelector = (productId) =>
  `[data-testid="cart-item-${productId}"]`;

export const getTabSelector = (tabName) =>
  `[role="tab"][aria-label="${tabName}"]`;
```

### Как генерировать selectors.js

Промпт для LLM:
```
Дан реестр компонентов (registry/components.json).
Сгенерируй файл cypress/support/selectors.js.

Правила:
1. Использовать preferred selector из каждого ComponentRecord
2. Группировать по pages (ключ = page slug в UPPER_SNAKE_CASE)
3. Компоненты со pages.length > 2 → поместить в GLOBAL
4. Имя константы = UPPER_SNAKE_CASE от component label
5. Добавить комментарий с confidence если не "high"
6. Для компонентов где ariaName содержит динамические данные (цифры, ID) →
   сгенерировать хелпер-функцию вместо статической строки
7. Добавить JSDoc комментарий с описанием компонента

Верни только код файла, без markdown.
```

---

## Шаг 2: Сгенерировать Cypress fixtures

Для каждого ComponentAction с network эффектом создать fixture файл.

### Формат fixture
```json
// cypress/fixtures/cart__checkout-btn--success.json
{
  "orderId": "order-12345",
  "total": 99.99,
  "status": "confirmed",
  "redirectUrl": "/confirmation/order-12345"
}
```

```json
// cypress/fixtures/cart__checkout-btn--error.json
{
  "error": "PAYMENT_FAILED",
  "message": "Payment method declined",
  "code": 402
}
```

### Генерация fixtures из responseShape
LLM берёт `action.network.responseShape` из ComponentRecord и генерирует
реалистичные фикстуры — один для success case, один для error case.

---

## Шаг 3: Генерация тестового файла

### 3.1 Структура теста — один файл на сценарий

Сценарий = последовательность шагов из одной сессии или её части.

```
cypress/e2e/
  cart/
    checkout-flow.cy.js       # сценарий: добавить товар → checkout → подтверждение
    empty-cart.cy.js          # сценарий: пустая корзина
    quantity-update.cy.js     # сценарий: изменить количество
```

### 3.2 Анатомия сгенерированного теста

```javascript
// АВТОГЕНЕРИРОВАННЫЙ ФАЙЛ
// Сессия: <sessionId>
// Шаги: step-001 → step-007
// Регенерировать: npm run generate:tests -- --session <sessionId>

import { SELECTORS } from '../../support/selectors';

describe('Cart: Checkout Flow', () => {

  // ─── Setup ────────────────────────────────────────────────────────────────

  beforeEach(() => {
    // Interceptors для network — ставим ДО cy.visit()
    cy.intercept('POST', '/api/checkout', {
      fixture: 'cart__checkout-btn--success.json'
    }).as('checkoutRequest');

    cy.intercept('GET', '/api/cart', {
      fixture: 'cart__get-cart--success.json'
    }).as('getCart');

    // Сбросить состояние
    cy.clearLocalStorage();
    cy.clearCookies();
  });

  // ─── Happy Path ───────────────────────────────────────────────────────────

  it('should complete checkout successfully', () => {
    // STEP 1: Открыть страницу корзины
    cy.visit('/cart');
    cy.wait('@getCart');

    // STEP 2: Убедиться что корзина не пустая
    cy.get(SELECTORS.CART.CART_TOTAL).should('be.visible');
    cy.get(SELECTORS.CART.EMPTY_STATE).should('not.exist');

    // STEP 3: Проверить кнопку Checkout доступна
    cy.get(SELECTORS.CART.CHECKOUT_BTN)
      .should('be.visible')
      .should('be.enabled')
      .should('contain.text', 'Checkout');

    // STEP 4: Клик Checkout
    cy.get(SELECTORS.CART.CHECKOUT_BTN).click();

    // STEP 5: Проверить network запрос
    cy.wait('@checkoutRequest').then((interception) => {
      expect(interception.response.statusCode).to.eq(200);
      // Проверить что orderId сохранился в localStorage
      cy.window().its('localStorage').invoke('getItem', 'orderId')
        .should('not.be.null');
    });

    // STEP 6: Проверить редирект
    cy.url().should('include', '/confirmation');
  });

  // ─── Edge Cases ───────────────────────────────────────────────────────────

  it('should disable checkout button when cart is empty', () => {
    cy.intercept('GET', '/api/cart', { body: { items: [] } }).as('emptyCart');
    cy.visit('/cart');
    cy.wait('@emptyCart');

    cy.get(SELECTORS.CART.CHECKOUT_BTN).should('be.disabled');
    cy.get(SELECTORS.CART.EMPTY_STATE).should('be.visible');
  });

  it('should handle checkout API error gracefully', () => {
    cy.intercept('POST', '/api/checkout', {
      statusCode: 402,
      fixture: 'cart__checkout-btn--error.json'
    }).as('checkoutFail');

    cy.visit('/cart');
    cy.get(SELECTORS.CART.CHECKOUT_BTN).click();
    cy.wait('@checkoutFail');

    // Должен показать сообщение об ошибке
    cy.get(SELECTORS.GLOBAL.ERROR_TOAST)
      .should('be.visible')
      .should('contain.text', 'Payment method declined');

    // Не должен редиректить
    cy.url().should('include', '/cart');
  });
});
```

---

## Шаг 4: Промпты для Test Generator Agent

### 4.1 Промпт: генерация happy path теста

```
Ты генерируешь Cypress тест на основе записанной сессии.

РЕЕСТР КОМПОНЕНТОВ (только релевантные для этой страницы):
<subset_of_registry_json>

ШАГИ СЕССИИ:
<session_steps_json>

ПРАВИЛА ГЕНЕРАЦИИ:
1. Импортировать SELECTORS из '../../support/selectors' — никаких хардкодных строк
2. Каждый cy.intercept() ставить В beforeEach, ДО cy.visit()
3. После каждого click() который триггерит network — cy.wait('@alias')
4. Проверять состояние ДО взаимодействия (pre_interaction assertions из реестра)
5. Проверять состояние ПОСЛЕ взаимодействия (post_interaction assertions из реестра)
6. Storage изменения (из storageDiff) проверять через cy.window().its('localStorage')
7. Добавить комментарий "// STEP N:" перед каждым логическим шагом
8. describe: "PageName: Scenario Name"
9. it: "should <действие> <ожидаемый результат>"

ЗАПРЕЩЕНО:
- cy.wait(1000) — только cy.wait('@networkAlias') или Cypress retry-ability
- хардкодные строки селекторов — только SELECTORS.X.Y
- cy.get('body').click() или другие ненадёжные действия
- игнорировать network эффекты из реестра

Верни только код файла без markdown блоков.
```

### 4.2 Промпт: генерация edge cases

```
На основе ComponentRecord для компонента <component_id>:
<component_record_json>

Сгенерируй edge case тесты для следующих сценариев:
1. Компонент в состоянии disabled (если states.disabled_when определён)
2. Компонент скрыт (если states.hidden_when определён)
3. Network error (статус 500) для каждого network action
4. Network timeout для каждого network action
5. Компонент в loading state (если states.loading_after определён)

Для каждого edge case — отдельный it() блок.
Использовать те же правила что и для happy path.
```

---

## Шаг 5: Централизованное обновление

### Как работает обновление при изменении реестра

```
registry/components.json изменился
       ↓
npm run generate:selectors
       → перегенерировать cypress/support/selectors.js
       ↓
npm run generate:fixtures
       → перегенерировать cypress/fixtures/ (только для изменённых компонентов)
       ↓
npm run generate:tests -- --affected-only
       → регенерировать только тесты затронутых компонентов
       ↓
git diff cypress/
       → человек ревьюит изменения
```

### Ручные правки в реестре
Поля для ручного редактирования в `registry/components.json`:
- `selectors.preferred` — поменять основной селектор
- `states.*` — добавить/исправить описание состояний
- `assertions.*` — добавить кастомные проверки
- `notes` — добавить контекст
- `manualOverride: true` — заморозить компонент от автообновления

После ручной правки — запустить `npm run generate:selectors` и тесты подхватят.

---

## Шаг 6: Структура команд (package.json scripts)

```json
{
  "scripts": {
    "collect": "node src/agents/main-navigator.js",
    "analyze": "node src/agents/run-analyzers.js",
    "resolve": "node src/agents/identity-resolution.js",
    "generate:selectors": "node src/generators/selectors-generator.js",
    "generate:fixtures": "node src/generators/fixtures-generator.js",
    "generate:tests": "node src/generators/test-generator.js",
    "generate:all": "npm run generate:selectors && npm run generate:fixtures && npm run generate:tests",
    "pipeline": "npm run collect && npm run analyze && npm run resolve && npm run generate:all"
  }
}
```

---

## Шаг 7: Правила написания тестов (для LLM и для людей)

### DO ✅
- `cy.get(SELECTORS.CART.CHECKOUT_BTN).click()` — всегда через реестр
- `cy.findByRole('button', { name: /checkout/i }).click()` — если нет testid
- `cy.wait('@networkAlias')` — всегда ждать network после actions с side effects
- `cy.get(selector).should('be.visible')` перед взаимодействием
- Один it() = один сценарий, независимый от других

### DON'T ❌
- `cy.get('.btn-primary').click()` — хардкод CSS
- `cy.wait(2000)` — произвольные таймауты
- Зависимость между тестами через глобальное состояние
- `cy.get('button:contains("Checkout")')` — хрупкий текстовый матч
- Проверять `cy.url().should('eq', '...')` с полным URL (лучше `include`)

---

## Шаг 8: Валидация сгенерированных тестов

После генерации прогнать автоматическую проверку:

```javascript
// src/validators/test-validator.js
// Проверить что в сгенерированных тестах:
// 1. Нет хардкодных селекторов (regex: /cy\.get\(['"`][.#\[]/g)
// 2. Все cy.wait() используют алиасы, не числа
// 3. Все импорты SELECTORS существуют в selectors.js
// 4. Все cy.intercept() стоят до cy.visit() в beforeEach
// Если нарушения — вернуть LLM для исправления с указанием строк
```
