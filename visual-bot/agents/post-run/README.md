# agents/post-run/

Пост-ран агенты: сравнение снапшотов и верификация выполнения задачи.

## Файлы

### `post-run-snapshot-compare-agent.ts` — классы `PostRunCompareAgent` / `PostRunSnapshotCompareAgent` / `PostRunVisualAgent`
Оркестратор сравнений. Делегирует работу двум специализированным агентам:
- `ScreenshotCompareAgent` (из `snapshot-compare/`) — сравнивает PNG/JPG скриншоты
- `SnapshotTextCompareAgent` (из `snapshot-text-compare/`) — сравнивает ARIA-снапшоты (.txt)

Методы: `process()`, `processScreenshots()`, `processSnapshots()`

---

### `post-run-visual-agent.ts`
Реэкспортирует `PostRunSnapshotCompareAgent` и `PostRunVisualAgent` как публичный интерфейс модуля. Сам логики не содержит.

---

### `task-verification-agent.ts` — класс `TaskVerificationAgent`
Верифицирует выполнение задачи: смотрит на последний ARIA-снапшот страницы и решает, выполнена ли задача. Текстовый агент — vision-модель не нужна.

**Вход:** описание задачи + ARIA-снапшот (текст, из `Agent.getLastAriaSnapshot()`)
**Выход:** `{ success: boolean, reason: string }` (ответы на русском)
**Фолбэк:** если снапшот не передан — самый новый `.txt` из `./screenshots/snapshots-incoming/`
**Поведение:** LLM строго оценивает, выполнена ли задача по дереву доступности (URL, заголовки, значения полей, алерты, открытые диалоги)
**Лимит:** снапшот обрезается до `VERIFICATION_SNAPSHOT_MAX_CHARS` (default 20000), голова + хвост

**Используется:** как финальный шаг после выполнения задачи агентом
