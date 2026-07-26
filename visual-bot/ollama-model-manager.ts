/**
 * Manages Ollama model load/unload via the /api/generate endpoint using `keep_alive`.
 * - load(name)   → POST /api/generate {model, keep_alive: KEEP_ALIVE}  (no prompt → just loads)
 * - unload(name) → POST /api/generate {model, keep_alive: 0}
 *
 * Controlled by MODEL_SWITCHING_ENABLED env var (default: enabled) and by
 * `localRuntimeInUse` — swapping is a no-op when every role runs in the cloud,
 * so a cloud-only run never pokes a local Ollama that may not even be there.
 */
export class OllamaModelManager {
  private baseUrl: string;
  private keepAlive: string;
  readonly enabled: boolean;

  constructor(localRuntimeInUse = true) {
    const v1Url = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
    this.baseUrl = v1Url.replace(/\/v1\/?$/, '');
    this.keepAlive = process.env.OLLAMA_KEEP_ALIVE || '30m';
    this.enabled = localRuntimeInUse && process.env.MODEL_SWITCHING_ENABLED !== 'false';
  }

  async load(identifier: string | undefined): Promise<void> {
    if (!this.enabled || !identifier) return;
    console.log(`\n[OllamaModelManager] Loading: ${identifier}`);
    const resp = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: identifier, keep_alive: this.keepAlive }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to load model "${identifier}": ${resp.status} ${text}`);
    }
    // Drain response stream so the connection closes cleanly.
    await resp.text();
    console.log(`[OllamaModelManager] Ready: ${identifier}`);
  }

  async unload(identifier: string | undefined): Promise<void> {
    if (!this.enabled || !identifier) return;
    console.log(`[OllamaModelManager] Unloading: ${identifier}`);
    const resp = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: identifier, keep_alive: 0 }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[OllamaModelManager] Unload warning for "${identifier}": ${resp.status} ${text}`);
      return;
    }
    await resp.text();
    console.log(`[OllamaModelManager] Unloaded: ${identifier}`);
  }

  /** Loads the model, runs fn(), then unloads — even if fn() throws. */
  async withModel<T>(identifier: string | undefined, fn: () => Promise<T>): Promise<T> {
    await this.load(identifier);
    try {
      return await fn();
    } finally {
      await this.unload(identifier);
    }
  }
}
