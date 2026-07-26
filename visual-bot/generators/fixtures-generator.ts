import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import type { ComponentRecord, ComponentRegistry } from '../pipeline/types.js';
import { runLlm } from '../agents/test-gen/llm-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type NetworkAction = NonNullable<ComponentRecord['actions'][0]['network']>;

export class FixturesGenerator {
  async generate(registryPath: string, fixturesDir: string): Promise<void> {
    if (!existsSync(registryPath)) {
      console.log('[FixturesGenerator] Registry not found:', registryPath);
      return;
    }

    const registry = JSON.parse(await readFile(registryPath, 'utf-8')) as ComponentRegistry;
    const components = Object.values(registry.components);

    const networkComponents = components.filter((c) =>
      c.actions.some((a) => a.network?.responseShape),
    );

    if (networkComponents.length === 0) {
      console.log('[FixturesGenerator] No components with network responseShape found');
      return;
    }

    console.log(`[FixturesGenerator] Generating fixtures for ${networkComponents.length} components…`);
    await mkdir(fixturesDir, { recursive: true });

    let written = 0;
    for (const comp of networkComponents) {
      for (const action of comp.actions) {
        if (!action.network?.responseShape) continue;
        const prefix = comp.id.slice(0, 60);
        await this._writeFixtures(comp, action, prefix, fixturesDir);
        written += 2;
      }
    }

    console.log(`[FixturesGenerator] Written ${written} fixture files to ${fixturesDir}`);
  }

  private _buildFixturePrompt(comp: ComponentRecord, action: ComponentRecord['actions'][0], net: NetworkAction): string {
    return `Generate realistic Cypress fixture JSON files for this API action.

Component: ${comp.label} (${comp.id})
Action type: ${action.type}
Network: ${net.method} ${net.urlPattern}
Expected status: ${net.expectedStatus}
Response shape: ${JSON.stringify(net.responseShape, null, 2)}

Return a JSON object with exactly two keys:
{
  "success": { ... },
  "error": { ... }
}

Rules:
- success: fill every field in responseShape with plausible example values
- error: include "error", "message", and "code" fields with realistic values
- No explanation, only the JSON object.`;
  }

  private async _generateFixtureData(
    comp: ComponentRecord,
    action: ComponentRecord['actions'][0],
    net: NetworkAction,
  ): Promise<{ successData?: unknown; errorData?: unknown }> {
    const prompt = this._buildFixturePrompt(comp, action, net);
    try {
      const text = await runLlm(prompt);
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return {};
      const parsed = JSON.parse(match[0]) as { success?: unknown; error?: unknown };
      return { successData: parsed.success, errorData: parsed.error };
    } catch (err) {
      console.warn(`[FixturesGenerator] Claude failed for ${comp.id}:`, (err as Error).message);
      return {};
    }
  }

  private async _writeFixtureFiles(
    fixturesDir: string,
    prefix: string,
    successData: unknown,
    errorData: unknown,
  ): Promise<void> {
    const successPath = join(fixturesDir, `${prefix}--success.json`);
    const errorPath = join(fixturesDir, `${prefix}--error.json`);

    await writeFile(successPath, JSON.stringify(successData, null, 2), 'utf-8');
    await writeFile(errorPath, JSON.stringify(errorData, null, 2), 'utf-8');
    console.log(`[FixturesGenerator]  ${prefix}--success.json`);
    console.log(`[FixturesGenerator]  ${prefix}--error.json`);
  }

  private async _writeFixtures(
    comp: ComponentRecord,
    action: ComponentRecord['actions'][0],
    prefix: string,
    fixturesDir: string,
  ): Promise<void> {
    const net = action.network;
    if (!net) return;

    const generated = await this._generateFixtureData(comp, action, net);
    let successData = generated.successData;
    let errorData = generated.errorData;

    if (!successData) successData = this._shapeToExample(net.responseShape ?? {});
    if (!errorData) errorData = { error: 'REQUEST_FAILED', message: 'The request could not be completed', code: 500 };

    await this._writeFixtureFiles(fixturesDir, prefix, successData, errorData);
  }

  private _valueForType(key: string, type: unknown): unknown {
    const t = String(type).toLowerCase();
    if (t.includes('id')) return `${key}-123`;
    if (t.includes('url')) return `/example/${key}`;
    if (t.includes('number') || t.includes('int') || t.includes('float')) return 0;
    if (t.includes('bool')) return true;
    if (t.includes('array')) return [];
    return `example-${key}`;
  }

  private _shapeToExample(shape: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, type] of Object.entries(shape)) {
      result[key] = this._valueForType(key, type);
    }
    return result;
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.replace(/\\/g, '/') === __filename.replace(/\\/g, '/');
if (isMain) {
  config({ path: resolve(__dirname, '..', '..', '.env') });

  const dataDir = resolve(__dirname, '..', '..', 'data');
  const cypressDir = resolve(__dirname, '..', '..', 'cypress-tests');
  const registryPath = join(dataDir, 'registry', 'components.json');
  const fixturesDir = join(cypressDir, 'cypress', 'fixtures');

  console.log('[FixturesGenerator] Registry:', registryPath);
  console.log('[FixturesGenerator] Fixtures:', fixturesDir, '\n');

  await new FixturesGenerator().generate(registryPath, fixturesDir);
}
