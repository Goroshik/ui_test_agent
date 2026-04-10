/**
 * Manages LM Studio model loading/unloading via the /api/v0 endpoint.
 * Controlled by MODEL_SWITCHING_ENABLED env var (default: true when models are configured).
 */
export class LmModelManager {
  private baseUrl: string;
  readonly enabled: boolean;

  constructor() {
    const v1Url = process.env.LM_STUDIO_BASE_URL || 'http://localhost:1234/v1';
    // Strip /v1 to get the LM Studio root URL
    this.baseUrl = v1Url.replace(/\/v1\/?$/, '');
    this.enabled = process.env.MODEL_SWITCHING_ENABLED !== 'false';
  }

  async load(identifier: string | undefined): Promise<void> {
    if (!this.enabled || !identifier) return;
    console.log(`\n[ModelManager] Loading: ${identifier}`);
    const resp = await fetch(`${this.baseUrl}/api/v0/models/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to load model "${identifier}": ${resp.status} ${text}`);
    }
    console.log(`[ModelManager] Ready: ${identifier}`);
  }

  async unload(identifier: string | undefined): Promise<void> {
    if (!this.enabled || !identifier) return;
    console.log(`[ModelManager] Unloading: ${identifier}`);
    const resp = await fetch(`${this.baseUrl}/api/v0/models/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      // Don't throw — model may already be unloaded or not found
      console.warn(`[ModelManager] Unload warning for "${identifier}": ${resp.status} ${text}`);
    } else {
      console.log(`[ModelManager] Unloaded: ${identifier}`);
    }
  }

  /**
   * Loads the model, runs fn(), then unloads — even if fn() throws.
   */
  async withModel<T>(identifier: string | undefined, fn: () => Promise<T>): Promise<T> {
    await this.load(identifier);
    try {
      return await fn();
    } finally {
      await this.unload(identifier);
    }
  }
}
