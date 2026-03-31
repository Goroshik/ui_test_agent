import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = resolve(__dirname, 'screenshots');

export class Screenshotter {
  async init() {
    if (!existsSync(SCREENSHOTS_DIR)) {
      await mkdir(SCREENSHOTS_DIR, { recursive: true });
    }
  }

  /**
   * Take a screenshot via MCP and save it to ./screenshots/
   * @param {number} step - sequential step number
   * @param {string} toolName - MCP tool that was just called
   * @param {object} toolArgs - arguments passed to the tool
   * @param {MCPClient} mcpClient - connected MCP client
   * @returns {string|null} saved file path, or null on failure
   */
  async capture(step, toolName, toolArgs, mcpClient) {
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

  async saveBase64(step, toolName, toolArgs, base64) {
    try {
      const filename = this.buildFilename(step, toolName, toolArgs);
      const filepath = resolve(SCREENSHOTS_DIR, filename);
      await writeFile(filepath, Buffer.from(base64, 'base64'));
      return filepath;
    } catch {
      return null;
    }
  }

  buildFilename(step, toolName, toolArgs) {
    const num = String(step).padStart(3, '0');

    // browser_navigate -> navigate, browser_click -> click, etc.
    const action = toolName.replace(/^browser_/, '').replace(/_/g, '-');

    // Pick the most meaningful argument for the filename
    const argValue =
      toolArgs?.url ||
      toolArgs?.selector ||
      toolArgs?.text ||
      toolArgs?.key ||
      toolArgs?.value ||
      '';

    let argPart = '';
    if (argValue) {
      argPart =
        '-' +
        String(argValue)
          .replace(/https?:\/\//, '')
          .replace(/[^a-z0-9._-]/gi, '_')
          .toLowerCase()
          .slice(0, 40);
    }

    return `${num}-${action}${argPart}.png`;
  }
}
