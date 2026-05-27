# agents/snapshot-compare/

Агент визуального сравнения скриншотов (PNG/JPG).

## Файлы

### `snapshot-compare-agent.ts` — классы `ScreenshotCompareAgent` / `SnapshotCompareAgent`
Расширяет `BaseCompareAgent`. Сравнивает входящие скриншоты с baseline через `VisualDiff` (LLM-сравнение).

**Директории:**
- Входящие: `./screenshots/incoming/`
- Baseline: `./screenshots/baseline/`
- Изменения: `./screenshots/changes/`

**Форматы файлов:** `.png`, `.jpg`

**Наследуемая логика (из BaseCompareAgent):**
- Ротация baseline и changes файлов
- `BASELINE_KEEP_COUNT` (default: 1) — сколько хранить baseline
- `CHANGES_KEEP_COUNT` (default: 5) — сколько хранить changes
- `CLEANUP_CHANGES_AFTER_PROCESS` (default: true) — очищать после обработки

**Используется из:** `post-run/post-run-snapshot-compare-agent.ts`
