import { appendFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';

export class RunLogger {
  private readonly logPath: string;
  private initialized = false;

  constructor(runId: string) {
    const logsDir = resolve(process.cwd(), 'logs');
    this.logPath = resolve(logsDir, `run-${runId}.log`);
  }

  async init(task: string): Promise<void> {
    const logsDir = resolve(process.cwd(), 'logs');
    if (!existsSync(logsDir)) {
      await mkdir(logsDir, { recursive: true });
    }
    await appendFile(
      this.logPath,
      `=== RUN START ===\nTask: ${task}\nTime: ${new Date().toISOString()}\n\n`,
      'utf-8'
    );
    this.initialized = true;
    console.log(`[Logger] Run log: ${this.logPath}`);
  }

  async logResponse(agent: string, content: string): Promise<void> {
    if (!this.initialized) return;
    const ts = new Date().toISOString();
    const entry = `[${ts}] [${agent}]\n${content}\n${'─'.repeat(60)}\n\n`;
    await appendFile(this.logPath, entry, 'utf-8');
  }

  async logEnd(): Promise<void> {
    if (!this.initialized) return;
    await appendFile(
      this.logPath,
      `=== RUN END ===\nTime: ${new Date().toISOString()}\n`,
      'utf-8'
    );
  }

  get path(): string {
    return this.logPath;
  }
}

/** Monkey-patch client.chat.completions.create to log every AI response. */
export function attachLogger(
  client: { chat: { completions: { create: (...args: unknown[]) => Promise<unknown> } } },
  logger: RunLogger,
  agentName: string
): void {
  const original = client.chat.completions.create.bind(client.chat.completions);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client.chat.completions as any).create = async (...args: unknown[]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (original as any)(...args);
    const content: string | undefined = (result as { choices?: { message?: { content?: string } }[] })
      ?.choices?.[0]?.message?.content ?? undefined;
    if (content) {
      await logger.logResponse(agentName, content);
    }
    return result;
  };
}
