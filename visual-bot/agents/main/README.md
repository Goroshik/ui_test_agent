# agents/main/

Главный агент браузерной автоматизации.

## Файлы

### `agent.ts` — класс `Agent`
Основной исполнительный агент. Управляет LLM-циклом, инструментами браузера и сбором данных для пайплайна.

**Что делает:**
- Запускает итеративный LLM-цикл (`run(prompt)`) до выполнения задачи или достижения `MAX_ITERATIONS`
- Подключается к Playwright через MCP-сервер (`MCPClient`)
- Выполняет 50+ браузерных инструментов (navigate, click, type, hover, snapshot и др.)
- После каждого изменения страницы — делает скриншот и/или ARIA-снапшот
- Собирает структурированные данные для пайплайна: ARIA, DOM, сеть, storage, скриншоты (`SessionCollector`)
- Записывает каждый шаг в MongoDB
- Детектирует зацикливание (loop detector)

**Зависимости:**
- `openai` — LLM-клиент (через LM Studio)
- `mongodb` — запись шагов
- `MCPClient` — Playwright MCP
- `Screenshotter` — захват экрана
- `SessionCollector` — сбор данных пайплайна
- `registry-context`, `memory.ts` — контекст страницы и посещений

**Переменные окружения:**
- `LM_STUDIO_BASE_URL`, `LM_STUDIO_API_KEY` — подключение к LM Studio
- `MAX_ITERATIONS` (default: 60)
- `PIPELINE_ENABLED` — включить сбор данных для пайплайна
- `SCREENSHOTS_ENABLED`, `SNAPSHOTS_ENABLED`
- `DEBUG` — verbose логирование
