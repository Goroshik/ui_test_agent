# TODO — Рефакторинг visual-bot

Предложения после анализа кодовой базы. Приоритет: высокий → низкий.

---

## Высокий приоритет

### 1. Проверить удалённые файлы — не сломано ли что
По `git status` удалены:
- `visual-bot/agents/post-run/dom-memory-agent.ts`
- `visual-bot/agents/post-run/page-memory-agent.ts`
- `visual-bot/analyze-dom-memory.ts`
- `visual-bot/analyze-memory.ts`
- `visual-bot/dom-memory.ts`

Нужно убедиться, что ничто из активного кода их не импортирует. Иначе — runtime-ошибки.

### 2. Разобраться с новыми файлами в корне visual-bot
Из `git status` появились новые файлы без очевидного места в архитектуре:
- `visual-bot/lm-model-manager.ts` — что это? Используется?
- `visual-bot/registry-context.ts` — уже используется в `main/agent.ts` и `planner/`, но нет README
- `visual-bot/run-pipeline.ts` — точка входа для пайплайна? Дублирует `pipeline-runner.ts`?

---

## Средний приоритет

### 3. Конкурентные записи в JSON-файлы
`dom-component-store.ts` и `content-summary-store.ts` — нет блокировок.  
Если запустить несколько сессий параллельно → race condition → потеря данных.  
**Решение:** добавить простую очередь записи или использовать append-only подход.

### 4. Захардкоженные пути в хранилищах
`data/content-summaries.json` и `data/dom-components.json` — пути зашиты прямо в файлах.  
Если `data/` нужно переместить — придётся менять код в нескольких местах.  
**Решение:** вынести в конфиг/env переменную `DATA_DIR`.

### 5. `post-run/post-run-visual-agent.ts` — лишний файл
Это просто реэкспорт из `post-run-snapshot-compare-agent.ts`. Никакой логики нет.  
**Решение:** убрать файл, перенести экспорты напрямую в `post-run-snapshot-compare-agent.ts`.

### 6. Дублирование путей к директориям
`snapshot-compare` и `snapshot-text-compare` оба хардкодят пути к `./screenshots/...`.  
Эти пути повторяются в `BaseCompareAgent` и его подклассах.  
**Решение:** передавать директории через конструктор.

---

## Низкий приоритет

### 7. `SessionCollector` — счётчик шагов не персистентный
Счётчик `nextStepId()` живёт только в памяти. Если создать новый экземпляр для той же сессии — начнёт с 1 и перезапишет старые шаги.  
**Решение:** при `init()` читать количество существующих шагов из файловой системы.

### 8. `task-verification-agent.ts` — ответы только на русском
Захардкожено в system prompt. Если проект будет использоваться на другом языке — нужно будет менять.  
**Решение:** передавать язык как параметр или убрать языковое ограничение.

### 9. Добавить README для корня `visual-bot/`
Есть README в подпапках, но нет общего обзора всего `visual-bot/` — что это, как запустить, какие env переменные нужны.

---

## Проверить перед удалением

Файлы из `git status` которые изменены, но роль неясна — стоит прочитать перед решением:
- `visual-bot/attention-memory.ts` (изменён)
- `visual-bot/memory.ts` (изменён)
- `visual-bot/run-logger.ts` (изменён)
- `visual-bot/utils.ts` (изменён)
- `visual-bot/visual-diff.ts` (изменён)
- `visual-bot/visual-text-diff.ts` (изменён)
