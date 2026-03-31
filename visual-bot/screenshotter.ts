import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { MCPClient } from './mcp-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = resolve(__dirname, '..', 'screenshots');
const INCOMING_DIR = resolve(SCREENSHOTS_DIR, 'incoming');

export class Screenshotter {
  async init(): Promise<void> {
    if (!existsSync(SCREENSHOTS_DIR)) {
      await mkdir(SCREENSHOTS_DIR, { recursive: true });
    }
    if (!existsSync(INCOMING_DIR)) {
      await mkdir(INCOMING_DIR, { recursive: true });
    }
  }

  async capture(
    step: number,
    toolName: string,
    toolArgs: Record<string, unknown>,
    mcpClient: MCPClient
  ): Promise<SavedScreenshot | null> {
    try {
      const result = await mcpClient.screenshot();
      if (!result?.content) return null;

      const imageContent = result.content.find((c) => c.type === 'image');
      if (!imageContent?.data) return null;

      return this.saveBase64(step, toolName, toolArgs, imageContent.data);
    } catch {
      return null;
    }
  }

  async saveBase64(
    step: number,
    toolName: string,
    toolArgs: Record<string, unknown>,
    base64: string
  ): Promise<SavedScreenshot | null> {
    try {
      const key = this.buildComparisonKey(toolName, toolArgs);
      const imageBuffer = Buffer.from(base64, 'base64');
      const filename = this.buildFilename(step, toolName, toolArgs, key);
      const filepath = resolve(INCOMING_DIR, filename);
      await writeFile(filepath, imageBuffer);
      return { key, path: filepath };
    } catch {
      return null;
    }
  }

  async saveSnapshot(
    step: number,
    toolName: string,
    toolArgs: Record<string, unknown>,
    text: string
  ): Promise<string | null> {
    try {
      const filename = this.buildFilename(step, toolName, toolArgs, undefined, '.txt');
      const filepath = resolve(SCREENSHOTS_DIR, filename);
      await writeFile(filepath, text, 'utf-8');
      return filepath;
    } catch {
      return null;
    }
  }

  buildFilename(
    step: number,
    toolName: string,
    toolArgs: Record<string, unknown>,
    keyOverride?: string,
    ext = '.png'
  ): string {
    const num = String(step).padStart(3, '0');

    // browser_navigate -> navigate, browser_click -> click, etc.
    const action = toolName.replace(/^browser_/, '').replace(/_/g, '-');

    // Pick the most meaningful argument for the filename
    const url = (toolArgs?.url as string) || '';
    const argValue =
      url ||
      (toolArgs?.selector as string) ||
      (toolArgs?.text as string) ||
      (toolArgs?.key as string) ||
      (toolArgs?.value as string) ||
      '';

    let argPart = '';
    if (argValue) {
      argPart =
        '-' +
        String(argValue)
          .replace(/https?:\/\//, '')
          .replace(/[^a-z0-9._-]/gi, '_')
          .toLowerCase()
          .slice(0, 60);
    }

    const now = new Date();
    const datePart =
      `${now.getFullYear()}` +
      `${String(now.getMonth() + 1).padStart(2, '0')}` +
      `${String(now.getDate()).padStart(2, '0')}` +
      `-${String(now.getHours()).padStart(2, '0')}` +
      `${String(now.getMinutes()).padStart(2, '0')}` +
      `${String(now.getSeconds()).padStart(2, '0')}`;

    const key = keyOverride ?? `${action}${argPart}`;
    return `${num}-${key}_${datePart}${ext}`;
  }

  buildComparisonKey(toolName: string, toolArgs: Record<string, unknown>): string {
    const action = toolName.replace(/^browser_/, '').replace(/_/g, '-');
    const url = (toolArgs?.url as string) || '';
    const argValue =
      url ||
      (toolArgs?.selector as string) ||
      (toolArgs?.text as string) ||
      (toolArgs?.key as string) ||
      (toolArgs?.value as string) ||
      '';

    const normalizedArg = argValue
      ? `-${String(argValue)
          .replace(/https?:\/\//, '')
          .replace(/[^a-z0-9._-]/gi, '_')
          .toLowerCase()
          .slice(0, 80)}`
      : '';

    return `${action}${normalizedArg}`;
  }
}

export interface SavedScreenshot {
  key: string;
  path: string;
}
