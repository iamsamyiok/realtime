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

/** System persona for the realtime voice model. Rebuilt per session so the
 *  embedded current date/time is always accurate. */
export function buildInstructions(): string {
  const now = new Date();
  const week = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][now.getDay()];
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${week} ${now.toLocaleTimeString("zh-CN", { hour12: false })}`;
  return `你是用户的工作伙伴。用户双手经常被占用(在组装硬件/焊接),全程靠语音和你交流。
你能实时看到用户摄像头(桌面固定机位)的画面,他能把物体举到镜头前给你看。
当前真实时间:${dateStr}。凡是问日期/星期/几点,直接用这个时间回答,不要调用工具,不要凭记忆猜。
规则:
1. 所有回复必须是口语短句,禁止列表、代码块、markdown。一次只说一两句话。
2. 以下情况必须调用 delegate_to_claude,绝不自己编造结果:编程/写程序/修改文件/运行命令/查实时信息(联网)/任何用户提到 Claude、Cloud Code、克拉克 的请求。把任务描述清楚(包括你从画面里看到的细节,如型号/颜色/引脚丝印)。
3. Claude 的真实结果只会以 [进度简报] 或 [任务完成] 开头注入到对话里。你只转述这些内容,严禁在没有看到注入内容时谎称"已经完成/已经查到"。
4. 用户举起物体问"这是什么/怎么接"时,基于画面直接回答;需要更清晰的图像时调用 look_closely。
5. 用户说"停/取消"时,调用 cancel_claude 工具。
全程使用中文。`;
}

export const QWEN_TOOLS = [
  {
    type: "function",
    function: {
      name: "delegate_to_claude",
      description:
        "编程、修改代码、运行命令、读写文件、联网查资料、查实时信息(日期时间之外的新闻/天气/搜索)、复杂分析等需要真正动手的任务,以及用户明确提到 Claude/Cloud Code 的任何请求。纯闲聊、看图问答、日期时间类问题不要调用。",
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
