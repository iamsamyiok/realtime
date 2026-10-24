import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { cfg, saveConfig, qwenWsUrl } from "./config.js";
import { QwenSession } from "./qwen.js";
import { ClaudeWorker } from "./claude.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- frame store ----------
type Frame = { base64: string; mime: string; ts: number };
const frameStore: { native: Frame | null; small: Frame | null } = { native: null, small: null };
let lastSpeechActivity = 0;
let framesReceived = 0;
let framesInjected = 0;
let captureInFlight = false;

let sharpMod: typeof import("sharp") | null = null;
try {
  sharpMod = (await import("sharp")).default;
} catch {
  console.warn("[frame] sharp unavailable - oversized frames will be passed through only if small enough");
}

async function toSmallJpeg(b64: string): Promise<Buffer | null> {
  const raw = Buffer.from(b64, "base64");
  if (sharpMod) {
    for (const q of [75, 60, 50]) {
      const buf = await sharpMod(raw).resize({ width: 1280 }).jpeg({ quality: q }).toBuffer();
      if (buf.length <= cfg.qwenImageMaxBytes) return buf;
    }
    return null;
  }
  return raw.length <= cfg.qwenImageMaxBytes ? raw : null;
}

function parseDataUrl(s: string): { b64: string; mime: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(s);
  return m ? { mime: m[1], b64: m[2] } : { mime: "image/jpeg", b64: s };
}

// ---------- mcp-webcam capture client ----------
let mcpClient: Client | null = null;
async function getMcp(): Promise<Client> {
  if (mcpClient) return mcpClient;
  const c = new Client({ name: "voice-hub", version: "0.1.0" });
  const t = new StreamableHTTPClientTransport(new URL(cfg.webcamMcp));
  await c.connect(t);
  mcpClient = c;
  return c;
}

async function captureOnce(): Promise<void> {
  if (captureInFlight) return;
  captureInFlight = true;
  try {
    const c = await getMcp();
    const res = await c.callTool({ name: "capture", arguments: {} });
    const img = (res.content as any[])?.find((x) => x.type === "image");
    if (img?.data) {
      await ingestFrame(img.data as string, img.mimeType ?? "image/jpeg");
    } else {
      const text = (res.content as any[])?.find((x) => x.type === "text");
      console.log("[frame] capture w/o image:", String(text?.text ?? "").slice(0, 90));
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (!/404|ECONNREFUSED/.test(msg)) console.warn("[frame] capture failed:", msg.slice(0, 120));
    mcpClient = null; // force reconnect next tick
  } finally {
    captureInFlight = false;
  }
}

async function ingestFrame(b64OrDataUrl: string, mime = "image/jpeg"): Promise<void> {
  const { b64 } = parseDataUrl(b64OrDataUrl);
  if (!b64) return;
  framesReceived++;
  frameStore.native = { base64: b64, mime, ts: Date.now() };
  const small = await toSmallJpeg(b64);
  if (small) frameStore.small = { base64: small.toString("base64"), mime: "image/jpeg", ts: Date.now() };

  broadcast({ t: "frame", thumb: smallBase64Url(frameStore.small) });

  // Push to Qwen per policy: near speech activity, always-mode, or while a
  // Claude task is running (so the agent can watch on-screen progress).
  if (cfg.frameMode !== "off" && frameStore.small) {
    const speechRecent = Date.now() - lastSpeechActivity < cfg.speechWindowMs;
    if (cfg.frameMode === "always" || speechRecent || claude.isBusy) {
      const r = qwen.maybeSendImage(Buffer.from(frameStore.small.base64, "base64"));
      if (r === "sent") framesInjected++;
    }
  }
}

function smallBase64Url(f: Frame | null): string | null {
  return f ? `data:${f.mime};base64,${f.base64.slice(0, 200_000)}` : null;
}

// ---------- Qwen + Claude ----------
type FrontMsg = { t: string; [k: string]: unknown };
const frontSockets = new Set<WebSocket>();

function broadcast(msg: FrontMsg): void {
  const s = JSON.stringify(msg);
  for (const ws of frontSockets) if (ws.readyState === WebSocket.OPEN) ws.send(s);
}

// De-duplication for spoken injections: Claude's last progress line often
// equals its final summary - never speak the same content twice.
const injectedNorms: string[] = [];
function normForDedup(s: string): string {
  return s.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase().slice(0, 60);
}
function speak(text: string, dedupe = true): void {
  const n = normForDedup(text);
  if (dedupe && injectedNorms.includes(n)) return;
  injectedNorms.push(n);
  if (injectedNorms.length > 8) injectedNorms.shift();
  qwen.sendTextItem(text);
  qwen.requestResponse();
}

const claude = new ClaudeWorker({
  onProgress: (line) => {
    broadcast({ t: "progress", line });
    speak(`[进度简报] ${line}`);
  },
  onDone: (summary) => {
    broadcast({ t: "agent_done", summary });
    const trimmed = summary.slice(0, 400);
    if (normForDedup(trimmed) === injectedNorms[injectedNorms.length - 1]) {
      speak("任务完成了,搞定了");
    } else {
      speak(`[任务完成] ${trimmed}`);
    }
  },
  onError: (message) => broadcast({ t: "error", message }),
  onBusy: (busy) => broadcast({ t: "busy", busy }),
});

const qwen = new QwenSession({
  onAudio: (b64) => broadcast({ t: "audio", d: b64 }),
  onStopAudio: () => broadcast({ t: "stop_audio" }),
  onTranscript: (who, text, final) => broadcast({ t: "transcript", who, text, final }),
  onState: (state, detail) => {
    console.log(`[qwen] state=${state} ${detail ?? ""}`);
    broadcast({ t: "qwen_state", state, detail });
  },
  onSpeechActivity: (speaking) => {
    if (speaking) lastSpeechActivity = Date.now();
  },
  onFunctionCall: async (name, argsJson, _callId) => {
    if (name === "delegate_to_claude") {
      let task = String((JSON.parse(argsJson) as any).task ?? "");
      if (!task) return { note: "任务描述为空" };
      // Delegation is long-running: acknowledge immediately, stream progress
      // via text items; the final summary is injected by onDone.
      const latest = frameStore.native;
      void claude
        .send(task, latest?.base64)
        .catch((e) => {
          qwen.sendTextItem(`[任务失败] ${(e as Error).message.slice(0, 200)}`);
          qwen.requestResponse();
        });
      return { status: "accepted", note: "任务已交给 Claude 执行,进度将陆续播报" };
    }
    if (name === "look_closely") {
      for (let i = 0; i < 3; i++) {
        await captureOnce();
        await new Promise((r) => setTimeout(r, 400));
      }
      return { note: "已获取高清连拍,画面已更新" };
    }
    if (name === "cancel_claude") {
      claude.interrupt();
      return { note: "已请求取消当前任务" };
    }
    return { note: `未知工具 ${name}` };
  },
});

// ---------- http + ws ----------
const app = express();
app.use(express.json({ limit: "60mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "voice-front.html")));

app.post("/frame", async (req, res) => {
  const { image } = req.body ?? {};
  if (image) await ingestFrame(String(image));
  res.json({ ok: true });
});

app.get("/api/status", (_req, res) => {
  res.json({
    qwenConfigured: !!cfg.dashscopeKey,
    qwenConnected: qwen.connected,
    claudeBusy: claude.isBusy,
    framesReceived,
    framesInjected,
    frameMode: cfg.frameMode,
    hasLatestFrame: !!frameStore.native,
    workspace: cfg.claudeWorkspace,
  });
});

// Manual test: pull one frame through the whole pipeline (MCP -> resize -> store)
app.post("/api/test-frame", async (_req, res) => {
  await captureOnce();
  res.json({
    ok: !!frameStore.native,
    framesReceived,
    nativeBytes: frameStore.native ? Math.floor((frameStore.native.base64.length * 3) / 4) : 0,
    smallBytes: frameStore.small ? Math.floor((frameStore.small.base64.length * 3) / 4) : 0,
  });
});

// Forget Claude history (next delegated task starts a fresh session)
app.post("/api/reset-claude", (_req, res) => {
  claude.resetSession();
  res.json({ ok: true });
});

// ---------- settings ----------
function maskKey(k: string): string {
  if (!k) return "";
  return k.length <= 8 ? "***" : k.slice(0, 5) + "****" + k.slice(-4);
}

app.get("/api/config", (_req, res) => {
  res.json({
    apiKeyMasked: maskKey(cfg.dashscopeKey),
    hasApiKey: !!cfg.dashscopeKey,
    workspaceIdMasked: cfg.workspaceId ? cfg.workspaceId.slice(0, 3) + "***" : "",
    hasWorkspaceId: !!cfg.workspaceId,
    model: cfg.qwenModel,
    voice: cfg.qwenVoice,
    region: cfg.qwenRegion,
    frameMode: cfg.frameMode,
    frameIntervalMs: cfg.frameIntervalMs,
  });
});

app.post("/api/config", (req, res) => {
  const b = req.body ?? {};
  const patch: Record<string, string> = {};
  if (typeof b.apiKey === "string" && b.apiKey.trim()) patch.DASHSCOPE_API_KEY = b.apiKey.trim();
  if (typeof b.workspaceId === "string" && b.workspaceId.trim()) patch.DASHSCOPE_WORKSPACE_ID = b.workspaceId.trim();
  if (typeof b.model === "string" && b.model.trim()) patch.QWEN_MODEL = b.model.trim();
  if (typeof b.voice === "string" && b.voice.trim()) patch.QWEN_VOICE = b.voice.trim();
  if (typeof b.region === "string" && ["cn-beijing", "ap-southeast-1"].includes(b.region)) patch.QWEN_REGION = b.region;
  if (typeof b.frameMode === "string" && ["off", "active", "always"].includes(b.frameMode)) patch.FRAME_MODE = b.frameMode;
  if (Number(b.frameIntervalMs) >= 1000) patch.FRAME_INTERVAL_MS = String(Math.floor(Number(b.frameIntervalMs)));
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "没有可保存的字段" });
  try {
    saveConfig(patch);
    // If a session is live and credentials/identity changed, reconnect fresh.
    if (cfg.dashscopeKey && cfg.workspaceId) qwen.reconnect();
    res.json({ ok: true, ...{ saved: Object.keys(patch) } });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** Quick realtime connectivity test: connect, try turn_detection variants, report. */
app.post("/api/test-qwen", async (_req, res) => {
  if (!cfg.dashscopeKey || !cfg.workspaceId) {
    return res.status(400).json({ ok: false, error: "请先填写 API Key 与 Workspace ID" });
  }
  const url = qwenWsUrl();
  const { default: WebSocket } = await import("ws");
  const audio = {
    input: { format: { type: "pcm", sample_rate: 16000, sample_format: "s16le", channels: 1, packing: "interleaved", channel_layout: "mono" } },
    output: { voice: cfg.qwenVoice, format: { type: "pcm", sample_rate: 24000 } },
  };
  const variants = [
    { turn_detection: { type: "semantic_vad" } },
    { turn_detection: "semantic_vad" },
    { turn_detection: null },
    { turn_detection: "manual" },
  ];
  const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    let settled = false;
    let vi = 0;
    let ws: any = null;
    const done = (ok: boolean, detail: string) => {
      if (!settled) { settled = true; resolve({ ok, detail }); try { ws?.close(); } catch {} }
    };
    const timer = setTimeout(() => done(false, "25s 内未完成会话配置(网络或参数问题)"), 25_000);
    const connect = () => {
      ws = new WebSocket(url, { headers: { Authorization: `Bearer ${cfg.dashscopeKey}` }, handshakeTimeout: 10_000 });
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "session.update", session: { modalities: ["text", "audio"], ...variants[vi], audio } }));
      });
      ws.on("message", (d: any) => {
        const ev = JSON.parse(d.toString());
        if (ev.type === "session.updated") { clearTimeout(timer); done(true, `会话配置成功(variant: ${JSON.stringify(variants[vi].turn_detection)}),模型 ${cfg.qwenModel}`); }
        if (ev.type === "error") {
          if (vi < variants.length - 1) { vi++; ws.removeAllListeners(); try { ws.close(); } catch {} connect(); }
          else { clearTimeout(timer); done(false, JSON.stringify(ev.error ?? ev).slice(0, 200)); }
        }
      });
      ws.on("error", (e: Error) => { clearTimeout(timer); done(false, e.message); });
    };
    connect();
  });
  res.json(result);
});

const server = app.listen(cfg.hubPort, () => {
  console.log(`[hub] voice-hub on http://localhost:${cfg.hubPort}`);
  if (!cfg.dashscopeKey) {
    console.log("[hub] DASHSCOPE_API_KEY not set - Qwen leg disabled (rest is usable)");
  } else {
    qwen.connect();
  }
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  frontSockets.add(ws);
  ws.send(JSON.stringify({ t: "hello", frameMode: cfg.frameMode }));
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      qwen.sendAudioPcm16(data as Buffer);
      return;
    }
    try {
      const msg = JSON.parse(data.toString()) as FrontMsg;
      if (msg.t === "text") {
        const text = String(msg.text ?? "").trim();
        if (!text) return;
        if (text.startsWith("/c ")) {
          const latest = frameStore.native;
          void claude.send(text.slice(3), latest?.base64).catch(() => {});
        } else if (/^(停|停止|取消)/.test(text)) {
          claude.interrupt();
        } else {
          qwen.sendTextItem(text);
          qwen.requestResponse();
        }
      } else if (msg.t === "speech") {
        if (msg.active) lastSpeechActivity = Date.now();
      }
    } catch {
      /* ignore malformed */
    }
  });
  ws.on("close", () => frontSockets.delete(ws));
});

// ambient frame poller — also runs while Claude works, so the agent can
// watch on-screen progress (capture is a sync canvas grab; race window is tiny)
setInterval(() => {
  if (cfg.frameMode === "off") return;
  if (!qwen.connected && cfg.frameMode === "active") return;
  void captureOnce();
}, cfg.frameIntervalMs);

// graceful shutdown
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log("\n[hub] shutting down...");
    qwen.close();
    try {
      mcpClient?.close();
    } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  });
}

// keep fs import used (workspace preflight)
if (!fs.existsSync(cfg.claudeWorkspace)) {
  fs.mkdirSync(cfg.claudeWorkspace, { recursive: true });
  console.log("[hub] created claude workspace:", cfg.claudeWorkspace);
}
