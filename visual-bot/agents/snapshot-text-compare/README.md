# agents/snapshot-text-compare/

Агент текстового сравнения ARIA-снапшотов (дерево доступности).

## Файлы

### `snapshot-text-compare-agent.ts` — класс `SnapshotTextCompareAgent`
Расширяет `BaseCompareAgent`. Сравнивает входящие текстовые снапшоты с baseline через `VisualTextDiff` (LLM-сравнение текста).

**Директории:**
- Входящие: `./screenshots/snapshots-incoming/`
- Baseline: `./screenshots/snapshots-baseline/`
- Изменения: `./screenshots/snapshots-changes/`

**Форматы файлов:** `.txt`

**Наследуемая логика (из BaseCompareAgent):**
- Ротация baseline и changes файлов
- `BASELINE_KEEP_COUNT` (default: 1)
- `CHANGES_KEEP_COUNT` (default: 5)
- `CLEANUP_CHANGES_AFTER_PROCESS` (default: true)

**Отличие от snapshot-compare/:** работает с текстом (ARIA-дерево), а не изображениями. Использует `VisualTextDiff` вместо `VisualDiff`.

**Используется из:** `post-run/post-run-snapshot-compare-agent.ts`
