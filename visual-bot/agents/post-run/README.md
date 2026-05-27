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
Верифицирует выполнение задачи: смотрит на последний скриншот и решает, выполнена ли задача.

**Вход:** описание задачи + скриншот (base64)  
**Выход:** `{ success: boolean, reason: string }` (ответы на русском)  
**Ищет скриншоты в:** `./screenshots/incoming/` (берёт самый новый)  
**Поведение:** LLM строго оценивает, выполнена ли задача по скриншоту

**Используется:** как финальный шаг после выполнения задачи агентом
