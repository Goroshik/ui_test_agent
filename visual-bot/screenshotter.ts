import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import type { MCPClient } from "./mcp-client.js";

const SCREENSHOTS_DIR = resolve(process.cwd(), "screenshots");
const INCOMING_DIR = resolve(SCREENSHOTS_DIR, "incoming");
const SNAPSHOTS_INCOMING_DIR = resolve(SCREENSHOTS_DIR, "snapshots-incoming");

export class Screenshotter {
  async init(): Promise<void> {
    if (!existsSync(SCREENSHOTS_DIR)) {
      await mkdir(SCREENSHOTS_DIR, { recursive: true });
    }
    if (!existsSync(INCOMING_DIR)) {
      await mkdir(INCOMING_DIR, { recursive: true });
    }
    if (!existsSync(SNAPSHOTS_INCOMING_DIR)) {
      await mkdir(SNAPSHOTS_INCOMING_DIR, { recursive: true });
    }
  }

  async capture(
    step: number,
    toolName: string,
    toolArgs: Record<string, unknown>,
    mcpClient: MCPClient,
  ): Promise<SavedScreenshot | null> {
    try {
      const result = await mcpClient.screenshot();
      if (!result?.content) return null;

      const imageContent = result.content.find((c) => c.type === "image");
      if (!imageContent?.data) return null;

      return this.saveBase64(step, toolName, toolArgs, imageContent.data);
    } catch (err) {
      console.error(`Screenshot capture failed: ${(err as Error).message}`);
      return null;
    }
  }

  async saveBase64(...saveArgs: SaveBase64Args): Promise<SavedScreenshot | null> {
    const [step, toolName, toolArgs, base64, url] = saveArgs;
    try {
      const key = this.buildComparisonKey(toolName, toolArgs);
      const imageBuffer = Buffer.from(base64, "base64");
      const ext = this.detectExt(imageBuffer);
      const filename = this.buildFilename(step, toolName, toolArgs, key, ext);
      const filepath = resolve(INCOMING_DIR, filename);
      await writeFile(filepath, imageBuffer);

      // Save sidecar metadata file with URL and context
      const meta = {
        url: url ?? null,
        step,
        tool: toolName,
        args: toolArgs,
        savedAt: new Date().toISOString(),
      };
      const metaFilepath = filepath.replace(/\.[^.]+$/, ".json");
      await writeFile(metaFilepath, JSON.stringify(meta, null, 2), "utf-8");

      return { key, path: filepath, url: url ?? null };
    } catch (err) {
      console.error(`Screenshot save failed: ${(err as Error).message}`);
      return null;
    }
  }

  private detectExt(buf: Buffer): string {
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
    if (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    )
      return ".png";
    return ".png";
  }

  async saveSnapshot(
    step: number,
    toolName: string,
    toolArgs: Record<string, unknown>,
    text: string,
  ): Promise<string | null> {
    try {
      const key = this.buildComparisonKey(toolName, toolArgs);
      const filename = this.buildFilename(
        step,
        toolName,
        toolArgs,
        key,
        ".txt",
      );
      const filepath = resolve(SNAPSHOTS_INCOMING_DIR, filename);
      await writeFile(filepath, text, "utf-8");
      return filepath;
    } catch (err) {
      console.error(`Snapshot save failed: ${(err as Error).message}`);
      return null;
    }
  }

  buildFilename(...filenameArgs: BuildFilenameArgs): string {
    const [step, toolName, toolArgs, keyOverride, ext = ".png"] = filenameArgs;
    const num = String(step).padStart(3, "0");

    // browser_navigate -> navigate, browser_click -> click, etc.
    const action = toolName.replace(/^browser_/, "").replace(/_/g, "-");

    const argValue = this.pickMeaningfulArg(toolArgs);

    let argPart = "";
    if (argValue) {
      argPart =
        "-" +
        String(argValue)
          .replace(/https?:\/\//, "")
          .replace(/[^a-z0-9._-]/gi, "_")
          .toLowerCase()
          .slice(0, 60);
    }

    const now = new Date();
    const datePart =
      `${now.getFullYear()}` +
      `${String(now.getMonth() + 1).padStart(2, "0")}` +
      `${String(now.getDate()).padStart(2, "0")}` +
      `-${String(now.getHours()).padStart(2, "0")}` +
      `${String(now.getMinutes()).padStart(2, "0")}` +
      `${String(now.getSeconds()).padStart(2, "0")}`;

    const key = keyOverride ?? `${action}${argPart}`;
    return `${num}-${key}_${datePart}${ext}`;
  }

  buildComparisonKey(
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): string {
    const action = toolName.replace(/^browser_/, "").replace(/_/g, "-");
    const argValue = this.pickStableArg(toolArgs);

    const normalizedArg = argValue
      ? `-${String(argValue)
          .replace(/https?:\/\//, "")
          .replace(/[^a-z0-9._-]/gi, "_")
          .toLowerCase()
          .slice(0, 80)}`
      : "";

    return `${action}${normalizedArg}`;
  }

  private pickStableArg(toolArgs: Record<string, unknown>): string {
    const values: string[] = [];

    const pushIfString = (value: unknown): void => {
      if (typeof value === "string" && value.trim()) values.push(value.trim());
    };

    // Keep keys stable across runs; avoid volatile values like ref (e123).
    pushIfString(toolArgs.url);
    pushIfString(toolArgs.selector);
    pushIfString(toolArgs.element);
    pushIfString(toolArgs.key);

    const index = toolArgs.index;
    if (typeof index === "number") values.push(`index-${index}`);

    const time = toolArgs.time;
    if (typeof time === "number") values.push(`time-${time}`);

    const valuesArg = toolArgs.values;
    if (Array.isArray(valuesArg) && valuesArg.length > 0) {
      values.push(`values-${valuesArg.join("_")}`);
    }

    // Fallback for tools where only free-text input exists.
    if (values.length === 0) {
      pushIfString(toolArgs.text);
      pushIfString(toolArgs.value);
    }

    return values.slice(0, 2).join("-");
  }

  private pickMeaningfulArg(toolArgs: Record<string, unknown>): string {
    const values: string[] = [];

    const pushIfString = (value: unknown): void => {
      if (typeof value === "string" && value.trim()) values.push(value.trim());
    };

    pushIfString(toolArgs.url);
    pushIfString(toolArgs.element);
    pushIfString(toolArgs.selector);
    pushIfString(toolArgs.text);
    pushIfString(toolArgs.key);
    pushIfString(toolArgs.value);
    pushIfString(toolArgs.ref);

    const index = toolArgs.index;
    if (typeof index === "number") values.push(`index-${index}`);

    const time = toolArgs.time;
    if (typeof time === "number") values.push(`time-${time}`);

    const valuesArg = toolArgs.values;
    if (Array.isArray(valuesArg) && valuesArg.length > 0) {
      values.push(`values-${valuesArg.join("_")}`);
    }

    return values.slice(0, 2).join("-");
  }
}

type SaveBase64Args = [
  step: number,
  toolName: string,
  toolArgs: Record<string, unknown>,
  base64: string,
  url?: string | null,
];

type BuildFilenameArgs = [
  step: number,
  toolName: string,
  toolArgs: Record<string, unknown>,
  keyOverride?: string,
  ext?: string,
];

export interface SavedScreenshot {
  key: string;
  path: string;
  url: string | null;
}
