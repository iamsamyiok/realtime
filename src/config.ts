import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
dotenv.config({ path: ENV_FILE });

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

export const cfg = {
  hubPort: num(process.env.HUB_PORT, 8090),

  // Qwen-Omni-Realtime (DashScope)
  dashscopeKey: process.env.DASHSCOPE_API_KEY ?? "",
  workspaceId: process.env.DASHSCOPE_WORKSPACE_ID ?? "",
  qwenModel: process.env.QWEN_MODEL ?? "qwen3.8-omni-flash-realtime",
  qwenVoice: process.env.QWEN_VOICE ?? "Tina",
  qwenRegion: process.env.QWEN_REGION ?? "cn-beijing",

  // Camera pipeline (mcp-webcam in streaming mode)
  webcamHttp: process.env.WEBCAM_URL ?? "http://localhost:3333",
  webcamMcp: process.env.WEBCAM_MCP_URL ?? "http://localhost:3333/mcp",

  // Claude Code sandbox
  claudeWorkspace: process.env.VOICE_WORKSPACE ?? path.join(os.homedir(), "voice-workspace"),

  // Frame policy: off | active (inject only near speech) | always
  frameMode: (process.env.FRAME_MODE ?? "active") as "off" | "active" | "always",
  frameIntervalMs: num(process.env.FRAME_INTERVAL_MS, 4000),
  qwenImageMaxBytes: num(process.env.QWEN_IMAGE_MAX_BYTES, 180_000),

  // Speech-activity window (ms): a frame may be pushed to Qwen within this
  // window after the last detected speech activity in "active" mode.
  speechWindowMs: num(process.env.SPEECH_WINDOW_MS, 10_000),
};

export function qwenWsUrl(): string {
  if (!cfg.workspaceId) throw new Error("DASHSCOPE_WORKSPACE_ID is not set");
  return `wss://${cfg.workspaceId}.${cfg.qwenRegion}.maas.aliyuncs.com/api-ws/v1/realtime?model=${cfg.qwenModel}`;
}

/** Persist a patch to .env and refresh the runtime cfg object. */
export function saveConfig(patch: Record<string, string>): void {
  const KEY_ALLOWED = new Set([
    "DASHSCOPE_API_KEY", "DASHSCOPE_WORKSPACE_ID", "QWEN_MODEL", "QWEN_VOICE",
    "QWEN_REGION", "FRAME_MODE", "FRAME_INTERVAL_MS", "HUB_PORT", "VOICE_WORKSPACE",
  ]);
  const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(patch)) {
    if (!KEY_ALLOWED.has(k)) continue;
    const re = new RegExp(`^${k}=`);
    const line = `${k}=${v}`;
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) lines[i] = line;
    else lines.push(line);
    // refresh runtime view
    switch (k) {
      case "DASHSCOPE_API_KEY": cfg.dashscopeKey = v; break;
      case "DASHSCOPE_WORKSPACE_ID": cfg.workspaceId = v; break;
      case "QWEN_MODEL": cfg.qwenModel = v; break;
      case "QWEN_VOICE": cfg.qwenVoice = v; break;
      case "QWEN_REGION": cfg.qwenRegion = v; break;
      case "FRAME_MODE": cfg.frameMode = v as typeof cfg.frameMode; break;
      case "FRAME_INTERVAL_MS": cfg.frameIntervalMs = num(v, cfg.frameIntervalMs); break;
      case "VOICE_WORKSPACE": cfg.claudeWorkspace = v; break;
    }
  }
  fs.writeFileSync(ENV_FILE, lines.filter((l) => l !== "").join("\n") + "\n", "utf8");
}

/** System persona for the realtime voice model. */
export const QWEN_INSTRUCTIONS = `你是用户的工作伙伴。用户双手经常被占用(在组装硬件/焊接),全程靠语音和你交流。
你能实时看到用户摄像头(桌面固定机位)的画面,他能把物体举到镜头前给你看。
规则:
1. 所有回复必须是口语短句,禁止列表、代码块、markdown。一次只说一两句话。
2. 需要编程、修改文件、运行命令、复杂分析时,调用 delegate_to_claude 工具,把任务描述清楚(包括你从画面里看到的细节,如型号/颜色/引脚丝印)。不要自己编造技术细节。
3. 用户举起物体问"这是什么/怎么接"时,先基于画面直接回答;需要更清晰的图像时调用 look_closely。
4. Claude 执行任务期间,你会陆续收到进度简报(function_call_output 之前可能有多条 input_text),收到后用口语转述给用户。
5. 用户说"停/取消"时,调用 cancel_claude 工具。
全程使用中文。`;

export const QWEN_TOOLS = [
  {
    type: "function",
    function: {
      name: "delegate_to_claude",
      description:
        "编程、修改代码、运行命令、读写文件、联网查资料、复杂分析等需要真正动手的任务。闲聊、看图问答、确认类对话不要调用。",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "完整的任务描述,包含从画面和对话中提取的关键信息" },
          priority: { type: "string", enum: ["now", "queue"], description: "now=立即执行,queue=当前有任务在跑则排队" },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "look_closely",
      description: "需要比当前画面更清晰的视觉细节时调用(触发高分辨率连拍并注入后续画面)",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_claude",
      description: "用户要求停止/取消当前正在执行的 Claude 任务时调用",
      parameters: { type: "object", properties: {} },
    },
  },
];
