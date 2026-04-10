import { appendFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { ObjectId } from 'mongodb';
import { isDBConnected, dbSaveLog } from './db.js';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export class RunLogger {
  private readonly logPath: string;
  private readonly errorPath: string;
  private initialized = false;
  private mongoRunId?: ObjectId;
  private tokenUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  constructor(runId: string, mongoRunId?: ObjectId) {
    const logsDir = resolve(process.cwd(), 'logs');
    this.logPath = resolve(logsDir, `run-${runId}.log`);
    this.errorPath = resolve(logsDir, `run-${runId}-errors.log`);
    this.mongoRunId = mongoRunId;
  }

  setMongoRunId(id: ObjectId): void {
    this.mongoRunId = id;
  }

  async init(task: string): Promise<void> {
    const logsDir = resolve(process.cwd(), 'logs');
    if (!existsSync(logsDir)) {
      await mkdir(logsDir, { recursive: true });
    }
    const header = `=== RUN START ===\nTask: ${task}\nTime: ${new Date().toISOString()}\n\n`;
    await appendFile(this.logPath, header, 'utf-8');
    this.initialized = true;
    console.log(`[Logger] Run log: ${this.logPath}`);
  }

  async logResponse(agent: string, content: string): Promise<void> {
    if (!this.initialized) return;
    const ts = new Date().toISOString();
    const entry = `[${ts}] [${agent}]\n${content}\n${'─'.repeat(60)}\n\n`;
    await appendFile(this.logPath, entry, 'utf-8');

    if (isDBConnected() && this.mongoRunId) {
      await dbSaveLog({ runId: this.mongoRunId, type: 'response', agent, content });
    }
  }

  async logError(tool: string, args: unknown, error: string): Promise<void> {
    if (!this.initialized) return;
    const ts = new Date().toISOString();
    const entry = `[${ts}] [ERROR] [${tool}]\nArgs: ${JSON.stringify(args, null, 2)}\nMessage: ${error}\n${'─'.repeat(60)}\n\n`;
    await appendFile(this.errorPath, entry, 'utf-8');

    if (isDBConnected() && this.mongoRunId) {
      await dbSaveLog({ runId: this.mongoRunId, type: 'error', tool, args, content: error });
    }
  }

  addTokenUsage(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }): void {
    this.tokenUsage.promptTokens += usage.prompt_tokens ?? 0;
    this.tokenUsage.completionTokens += usage.completion_tokens ?? 0;
    this.tokenUsage.totalTokens += usage.total_tokens ?? 0;
  }

  getTokenUsage(): TokenUsage {
    return { ...this.tokenUsage };
  }

  async logEnd(): Promise<void> {
    if (!this.initialized) return;
    const usage = this.tokenUsage;
    const usageLine = `Tokens — prompt: ${usage.promptTokens}, completion: ${usage.completionTokens}, total: ${usage.totalTokens}\n`;
    await appendFile(
      this.logPath,
      `=== RUN END ===\nTime: ${new Date().toISOString()}\n${usageLine}`,
      'utf-8'
    );
    console.log(`[Logger] ${usageLine.trim()}`);
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
    const result = await (original as any)(...args) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = result?.choices?.[0]?.message?.content ?? undefined;
    if (content) {
      await logger.logResponse(agentName, content);
    }
    if (result?.usage) {
      logger.addTokenUsage(result.usage);
    }
    return result;
  };
}
