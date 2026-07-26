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
- `openai` — LLM-клиент (через OpenRouter по умолчанию, см. `llm-provider.ts`)
- `mongodb` — запись шагов
- `MCPClient` — Playwright MCP
- `Screenshotter` — захват экрана
- `SessionCollector` — сбор данных пайплайна
- `registry-context`, `memory.ts` — контекст страницы и посещений

**Переменные окружения:**
- `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` — подключение к OpenRouter (провайдер по умолчанию)
- `MAIN_PROVIDER` / `LLM_PROVIDER` — `openrouter` (default) или `ollama`
- `MAIN_MODEL` — модель для этой роли; нужна vision-модель, если включены скриншоты
- `OLLAMA_BASE_URL`, `OLLAMA_API_KEY` — подключение к локальной Ollama (если выбрана)
- `MAX_ITERATIONS` (default: 60)
- `PIPELINE_ENABLED` — включить сбор данных для пайплайна
- `SCREENSHOTS_ENABLED`, `SNAPSHOTS_ENABLED`
- `DEBUG` — verbose логирование
