import path from "node:path";
import { query, type Query, type SDKUserMessage, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { cfg } from "./config.js";

export type ClaudeCallbacks = {
  /** short progress lines while the agent works (already throttled) */
  onProgress: (line: string) => void;
  /** final answer text when the turn completes */
  onDone: (summary: string) => void;
  onError: (message: string) => void;
  onBusy: (busy: boolean) => void;
};

/** Bash commands safe to auto-approve in the sandbox workspace. */
const SAFE_BASH = /^(npm (test|run|install|ci)|npx |node |python |pip |idf\.py|ls|dir|cat|type|git (status|diff|log|add|commit)|echo|mkdir|cd)\b/;
const ALLOWED_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite"]);

/**
 * A long-lived Claude Code session driven through the Agent SDK's
 * streaming-input mode (query() with an AsyncIterable prompt).
 * Verified against @anthropic-ai/claude-agent-sdk 0.3.309 type defs:
 *  - SDKUserMessage.message is a full MessageParam: content may be a string
 *    or content-block array (text, image, ...)  -> images attached directly.
 *  - Options.canUseTool / permissionMode / mcpServers http-type supported.
 *  - Query.interrupt(): Promise<...> exists.
 */
export class ClaudeWorker {
  private queryHandle: Query | null = null;
  private queue: SDKUserMessage[] = [];
  private queueWake: (() => void) | null = null;
  private busy = false;
  private pending: { resolve: (s: string) => void; reject: (e: Error) => void } | null = null;
  private lastProgressAt = 0;

  constructor(private cb: ClaudeCallbacks) {}

  get isBusy(): boolean {
    return this.busy;
  }

  private canUseTool: CanUseTool = async (toolName, input) => {
    if (ALLOWED_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: input };
    if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
      const p = String((input as any).file_path ?? (input as any).notebook_path ?? (input as any).path ?? "");
      const inside = path.resolve(p).toLowerCase().startsWith(path.resolve(cfg.claudeWorkspace).toLowerCase());
      if (inside) return { behavior: "allow", updatedInput: input };
      const msg = `只能写入沙箱工作区(${cfg.claudeWorkspace})内的文件,已拒绝: ${p}`;
      console.warn("[claude] denied path:", p);
      return { behavior: "deny", message: msg };
    }
    if (toolName === "Bash" && SAFE_BASH.test(String(input.command ?? ""))) {
      return { behavior: "allow", updatedInput: input };
    }
    const msg = `操作 ${toolName} 不在语音放行清单内,已拒绝。如需执行请手动在 ${cfg.claudeWorkspace} 中确认。`;
    console.warn(`[claude] denied: ${toolName} ${JSON.stringify(input).slice(0, 120)}`);
    return { behavior: "deny", message: msg };
  };

  private async *inputStream(): AsyncIterable<SDKUserMessage> {
    while (true) {
      if (this.queue.length === 0) {
        await new Promise<void>((r) => (this.queueWake = r));
        this.queueWake = null;
      }
      const msg = this.queue.shift();
      if (msg) yield msg;
    }
  }

  private startSession(): void {
    console.log("[claude] starting Agent SDK session, cwd =", cfg.claudeWorkspace);
    const q = query({
      prompt: this.inputStream(),
      options: {
        cwd: cfg.claudeWorkspace,
        permissionMode: "acceptEdits",
        canUseTool: this.canUseTool,
        allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Bash", "TodoWrite"],
        mcpServers: {
          webcam: { type: "http", url: cfg.webcamMcp },
        },
        settingSources: [],
      },
    });
    this.queryHandle = q;

    void (async () => {
      try {
        for await (const msg of q) {
          if (msg.type === "assistant") {
            const blocks: any[] = (msg.message as any)?.content ?? [];
            const text = blocks
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join(" ")
              .trim();
            if (text) this.emitProgress(text);
          } else if (msg.type === "result") {
            const summary = String((msg as any).result ?? "").trim();
            if (this.pending) {
              this.pending.resolve(summary);
              this.pending = null;
            }
            this.busy = false;
            this.cb.onBusy(false);
            this.cb.onDone(summary || "(任务完成,无文本输出)");
          }
        }
      } catch (e) {
        console.error("[claude] stream error:", (e as Error).message);
        this.cb.onError((e as Error).message);
        if (this.pending) {
          this.pending.reject(e as Error);
          this.pending = null;
        }
        this.busy = false;
        this.cb.onBusy(false);
      }
    })();
  }

  private emitProgress(text: string): void {
    const now = Date.now();
    if (now - this.lastProgressAt < 2500) return;
    this.lastProgressAt = now;
    const line = text.replace(/\s+/g, " ").slice(0, 90);
    this.cb.onProgress(line);
  }

  /** Send a delegated task; resolves with Claude's final summary. */
  send(task: string, imageBase64?: string): Promise<string> {
    if (!this.queryHandle) this.startSession();

    const content: any[] = [];
    if (imageBase64) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: imageBase64 },
      });
    }
    content.push({
      type: "text",
      text:
        `${task}\n\n[上下文] 附件是摄像头当前画面,如与本任务相关请先查看。` +
        `完成后请给出一段不超过三句话的中文总结(口语化,将转为语音)。`,
    });

    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    };

    const p = new Promise<string>((resolve, reject) => (this.pending = { resolve, reject }));
    if (this.busy) throw new Error("Claude 正忙,请稍后或使用 queue");
    this.busy = true;
    this.cb.onBusy(true);
    this.lastProgressAt = 0;
    this.queue.push(msg);
    this.queueWake?.();
    return p;
  }

  interrupt(): void {
    if (this.queryHandle && this.busy) {
      console.log("[claude] interrupt requested");
      void this.queryHandle.interrupt();
    }
  }
}
