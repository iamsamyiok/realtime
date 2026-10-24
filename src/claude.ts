import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  query,
  createSdkMcpServer,
  tool,
  type Query,
  type SDKUserMessage,
  type CanUseTool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { cfg } from "./config.js";

const execFileAsync = promisify(execFile);
const SEARCH_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".claude", "skills", "smart-search", "scripts", "search.mjs");

/** In-process MCP server exposing the smart-search degradation chain
 *  (AnySearch → Tavily → Exa) to the delegated Claude session, so web
 *  search keeps working when the provider's built-in search quota is out. */
const smartSearchServer = createSdkMcpServer({
  name: "smart-search",
  version: "1.0.0",
  tools: [
    tool(
      "web_search",
      "网络搜索(优雅降级链:AnySearch→Tavily→Exa)。当内置 WebSearch/WebFetch 因配额不足、限流(429)或失败时,必须改用此工具。返回带标题/URL/摘要的结果列表。",
      {
        query: z.string().describe("搜索关键词"),
        num: z.number().optional().describe("结果条数,默认 5,最多 10"),
        intl: z.boolean().optional().describe("true=国际检索(默认中文)"),
      },
      async ({ query: q, num, intl }) => {
        try {
          const args = [SEARCH_SCRIPT, q, "--num", String(num ?? 5), "--content"];
          if (intl) args.push("--intl");
          const { stdout } = await execFileAsync(process.execPath, args, {
            timeout: 90_000,
            maxBuffer: 4 * 1024 * 1024,
            encoding: "utf8",
          });
          return { content: [{ type: "text", text: stdout }] };
        } catch (e: any) {
          const detail = (e.stdout ? String(e.stdout) + "\n" : "") + (e.message ?? e);
          return { content: [{ type: "text", text: `搜索失败: ${String(detail).slice(0, 300)}` }] };
        }
      },
    ),
  ],
});

const SESSION_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".claude-session-id");

export type ClaudeCallbacks = {
  /** short progress lines while the agent works (already throttled) */
  onProgress: (line: string) => void;
  /** final answer text when the turn completes (suppressed if cancelled) */
  onDone: (summary: string) => void;
  /** the task was cancelled by the user or timed out */
  onCancelled: (reason: string) => void;
  onError: (message: string) => void;
  onBusy: (busy: boolean) => void;
};

/** Bash commands safe to auto-approve in the sandbox workspace. */
const SAFE_BASH = /^(npm (test|run|install|ci)|npx |node |python |pip |idf\.py|ls|dir|cat|type|git (status|diff|log|add|commit)|echo|mkdir|cd)\b/;
const ALLOWED_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "mcp__smart-search__web_search"]);

type ActiveTask = {
  label: string;
  resolve: (s: string) => void;
  reject: (e: Error) => void;
  cancelled: boolean;
  timedOut: boolean;
  superseded: boolean;
  timeout: NodeJS.Timeout | null;
};

type QueuedTask = { msg: SDKUserMessage; label: string; resolve: (s: string) => void; reject: (e: Error) => void };

/**
 * A long-lived Claude Code session driven through the Agent SDK's
 * streaming-input mode (query() with an AsyncIterable prompt).
 *
 * Maturity features:
 *  - task queue (serialize; callers may enqueue while busy)
 *  - per-task timeout (auto-interrupt + spoken "timed out")
 *  - user cancellation ("停") suppresses the final-result speech
 *  - session id persisted; hub restarts resume the same conversation
 */
export class ClaudeWorker {
  private queryHandle: Query | null = null;
  private streamQueue: SDKUserMessage[] = [];
  private queueWake: (() => void) | null = null;
  private waiting: QueuedTask[] = [];
  private active: ActiveTask | null = null;
  private pending: { resolve: (s: string) => void; reject: (e: Error) => void } | null = null;
  private lastProgressAt = 0;
  /** description of a task that was superseded and should auto-continue */
  requeueAfter: string | null = null;

  constructor(private cb: ClaudeCallbacks) {}

  get isBusy(): boolean {
    return this.active !== null;
  }

  get queueLength(): number {
    return this.waiting.length;
  }

  private canUseTool: CanUseTool = async (toolName, input) => {
    if (ALLOWED_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: input };
    if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
      const p = String((input as any).file_path ?? (input as any).notebook_path ?? (input as any).path ?? "");
      // The SDK spawns the CLI with cwd = workspace, so relative paths are
      // relative to the workspace — resolve against it, not the hub process.
      const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cfg.claudeWorkspace, p);
      const inside = resolved.toLowerCase().startsWith(path.resolve(cfg.claudeWorkspace).toLowerCase());
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
      if (this.streamQueue.length === 0) {
        await new Promise<void>((r) => (this.queueWake = r));
        this.queueWake = null;
      }
      const msg = this.streamQueue.shift();
      if (msg) yield msg;
    }
  }

  private startSession(): void {
    // Persist the session id so hub restarts resume the same conversation
    // ("开启一次,持续挂后台,不忘记历史").
    let resumeId: string | undefined;
    try {
      if (fs.existsSync(SESSION_FILE)) {
        resumeId = fs.readFileSync(SESSION_FILE, "utf8").trim() || undefined;
      }
    } catch {}
    console.log("[claude] starting Agent SDK session, cwd =", cfg.claudeWorkspace,
                resumeId ? `(resuming ${resumeId.slice(0, 8)}...)` : "(fresh)");
    const q = query({
      prompt: this.inputStream(),
      options: {
        cwd: cfg.claudeWorkspace,
        permissionMode: "acceptEdits",
        canUseTool: this.canUseTool,
        allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Bash", "TodoWrite", "NotebookEdit"],
        // Tool search defers Bash/Write/etc. behind a search tool, which made
        // the model conclude it "has no file tools". Disable the searcher so
        // the full toolset stays in-context.
        disallowedTools: ["ToolSearch"],
        mcpServers: {
          webcam: { type: "http", url: cfg.webcamMcp },
          "smart-search": smartSearchServer,
        },
        settingSources: [],
        ...(resumeId ? { resume: resumeId } : {}),
      },
    });
    this.queryHandle = q;

    void (async () => {
      try {
        for await (const msg of q) {
          const sid = (msg as any).session_id;
          if (sid) {
            try { fs.writeFileSync(SESSION_FILE, String(sid), "utf8"); } catch {}
          }
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
            this.finishActive(summary);
          }
        }
        // Stream ended (interrupt can close it): drop the handle so the next
        // task starts a fresh query — resume brings the history back.
        this.queryHandle = null;
        if (this.active || this.pending) {
          const task = this.active;
          this.active = null;
          if (this.pending) {
            this.pending.resolve(task?.cancelled ? "(已取消)" : "(会话已结束)");
            this.pending = null;
          }
          if (task) {
            if (task.timeout) clearTimeout(task.timeout);
            if (task.cancelled) this.cb.onCancelled("用户取消");
            else if (task.timedOut) this.cb.onCancelled("任务超时,已自动停止");
            else this.cb.onDone(task.label + " — 会话流已结束,未完成");
          }
          this.busyGuard();
        }
      } catch (e) {
        console.error("[claude] stream error:", (e as Error).message);
        this.cb.onError((e as Error).message);
        this.failActive(new Error((e as Error).message));
      }
    })();
  }

  /** Resolve the active task, speak the outcome, then drain the queue. */
  private finishActive(summary: string): void {
    const task = this.active;
    this.active = null;
    if (this.pending) {
      this.pending.resolve(summary);
      this.pending = null;
    }
    if (task) {
      if (task.timeout) clearTimeout(task.timeout);
      if (task.superseded) {
        /* superseded: hub already announced the switch; no speech here */
      } else if (task.cancelled) this.cb.onCancelled("用户取消");
      else if (task.timedOut) this.cb.onCancelled("任务超时,已自动停止");
      else this.cb.onDone(summary || "(任务完成,无文本输出)");
    }
    this.busyGuard();
  }

  private failActive(e: Error): void {
    const task = this.active;
    this.active = null;
    if (this.pending) {
      this.pending.reject(e);
      this.pending = null;
    }
    if (task?.timeout) clearTimeout(task.timeout);
    this.busyGuard();
  }

  /** Start the next queued task if any (keeps busy flag correct). */
  private busyGuard(): void {
    if (this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      this.cb.onBusy(true);
      this.activate(next.msg, next.label, next.resolve, next.reject);
    } else {
      this.cb.onBusy(false);
    }
  }

  private emitProgress(text: string): void {
    const now = Date.now();
    if (now - this.lastProgressAt < 2500) return;
    this.lastProgressAt = now;
    const line = text.replace(/\s+/g, " ").slice(0, 90);
    this.cb.onProgress(line);
  }

  /** Send a delegated task; resolves with Claude's final summary.
   *  If a task is already running, the new one is queued (FIFO, capped). */
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
        `需要联网搜索时优先用 WebSearch;若它因配额/限流失败,改用 mcp__smart-search__web_search 工具。` +
        `完成后请给出一段不超过三句话的中文总结(口语化,将转为语音)。`,
    });

    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    };

    if (this.active) {
      if (this.waiting.length >= 3) {
        return Promise.reject(new Error("任务队列已满(3 个),请等当前任务完成"));
      }
      console.log(`[claude] queued task (${this.waiting.length + 1} waiting)`);
      return new Promise<string>((resolve, reject) => this.waiting.push({ msg, resolve, reject, label: task }));
    }

    return new Promise<string>((resolve, reject) => this.activate(msg, task, resolve, reject));
  }

  /** Supersede the running task with a new one: cancel old, start new, and
   *  return the old task's description so the caller can auto-continue it
   *  afterwards (the persistent session remembers where it left off). */
  supersede(task: string, imageBase64?: string): string | null {
    const old = this.active;
    if (old) old.superseded = true;
    for (const t of this.waiting) t.reject(new Error("被新任务取代"));
    this.waiting = [];
    this.interrupt("被新任务取代");
    void this.send(task, imageBase64);
    return old ? old.label : null;
  }

  private activate(msg: SDKUserMessage, label: string, resolve: (s: string) => void, reject: (e: Error) => void): void {
    this.cb.onBusy(true);
    this.lastProgressAt = 0;
    const task: ActiveTask = {
      label,
      resolve, reject, cancelled: false, timedOut: false, superseded: false,
      timeout: cfg.taskTimeoutMs > 0
        ? setTimeout(() => {
            if (this.active) {
              console.warn("[claude] task timeout - interrupting");
              task.timedOut = true;
              this.interrupt();
            }
          }, cfg.taskTimeoutMs)
        : null,
    };
    this.active = task;
    this.pending = { resolve, reject };
    this.streamQueue.push(msg);
    this.queueWake?.();
  }

  /** User said "停" or a timeout fired: interrupt and mark cancelled.
   *  Also drops the waiting queue — "stop" means everything stops. */
  cancelAll(reason = "用户取消"): void {
    for (const t of this.waiting) t.reject(new Error("已取消"));
    this.waiting = [];
    this.interrupt(reason);
  }

  interrupt(reason = "用户取消"): void {
    if (this.queryHandle && this.active) {
      console.log("[claude] interrupt requested:", reason);
      this.active.cancelled = true;
      void this.queryHandle.interrupt();
    }
  }

  /** Forget history: clear the persisted session id; the next task starts fresh. */
  resetSession(): void {
    try { fs.unlinkSync(SESSION_FILE); } catch {}
    if (this.queryHandle) {
      try { this.queryHandle.close(); } catch {}
      this.queryHandle = null;
    }
    for (const t of this.waiting) t.reject(new Error("会话已重置"));
    this.waiting = [];
    if (this.active) {
      this.active.reject(new Error("会话已重置"));
      this.active = null;
    }
    this.cb.onBusy(false);
    console.log("[claude] session reset - next task starts fresh");
  }
}
