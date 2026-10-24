# Realtime 🎙️

> 语音 + 摄像头 + Claude Code。开启一次,Claude 会话持续挂在后台 —— hub 重启也不丢历史(session resume)。

**语音 × Claude Code × 摄像头** — 把 Qwen-Omni-Realtime 的实时语音/视觉能力和 Claude Code 的编码能力缝在一起:你对麦克风说话、把物体举到摄像头前,Qwen 实时听/看/答;需要真正动手(写代码、跑命令、查资料)时,它自动把任务委派给 Claude Code,进度和结果再转成语音播报给你。全程双手自由。

[English] VoiceBridge lets you talk to your computer: Qwen-Omni-Realtime handles speech-to-speech with live camera vision, and delegates hands-on work (coding, shell, research) to Claude Code via function calling. Results are spoken back. Hands-free, human-like.

```
浏览器(mic/扬声器) ──PCM16k──▶ voice-hub ──▶ Qwen-Omni-Realtime WS(语音+实时图像)
      ▲                          │  ▲              (semantic VAD / TTS / 视觉缓冲)
      └────24kHz PCM 播放────────┘  └── function call ──▶ Claude Code(Agent SDK 流式会话)
mcp-webcam(唯一持相机者, :3333) ──MCP capture──▶ hub ──┬─ 720P JPEG ─▶ Qwen 视觉缓冲
                                                      └─ 原图 ─────▶ Claude 消息附件
```

## 组件

| 目录 | 说明 |
|---|---|
| `src/` | voice-hub 中枢:Qwen WS 会话、Claude Agent SDK 工作进程、帧总线、Web/WS 服务 |
| `public/voice-front.html` | 浏览器前端(麦克风采集、音频播放、转写/进度 UI、模型配置面板) |
| `test/poc-qwen.mjs` | Qwen 腿 PoC(连接/会话配置/音频图像缓冲/工具注册) |
| `test/test-claude.mjs` | Claude 腿冒烟测试 |

配套(不在本仓库):
- [mcp-webcam](https://github.com/evalstate/mcp-webcam) —— 浏览器采集摄像头并作为 MCP 服务器暴露 `capture` 工具。本仓库用它前需要打一个 8 行小补丁(见下)
- 设计文档见 `docs/DESIGN.md`(协议事实/时序/风险清单)

## 快速开始

```bash
# 0) 前置:Node 20+,一个 DashScope API Key(百炼),Claude Code 已登录
# 1) 安装
npm install && npm run build
cp .env.example .env      # 填入 DASHSCOPE_API_KEY / DASHSCOPE_WORKSPACE_ID 等

# 2) 启动相机服务(mcp-webcam,先按下面"补丁"改造)
cd ../mcp-webcam && npm run build
VOICE_HUB_FORWARD_URL=http://localhost:8090/frame node dist/server.js --streaming

# 3) 启动中枢
cd ../voice-hub && node dist/hub.js

# 4) 浏览器打开
#    http://localhost:3333  → 相机页(唯一持相机者,允许相机)
#    http://localhost:8090  → 语音页(点"开始对话",允许麦克风)
```

也可以不填 key 直接用文字兜底:语音页输入 `/c <任务>` 直接驱动 Claude。

## mcp-webcam 补丁(8 行)

在 `server.ts` 的 `POST /api/capture-result` handler 里加入帧镜像(env 门控):

```ts
const voiceHub = process.env.VOICE_HUB_FORWARD_URL;
if (voiceHub && image) {
  fetch(voiceHub, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image, user }),
  }).catch(() => {});
}
```

## 工作方式(要点)

- **打断**:Qwen `semantic_vad` 检测到说话即 `response.cancel` 并清空播放(官方推荐模式)
- **视觉**:帧经 hub 分轨 —— Qwen 收 720P JPEG(官方限单张 base64 后 ≤256KB,建议 1fps);
  Claude 收原生分辨率作为消息图像块;`FRAME_MODE=active` 时仅在语音活动后注图以省 token
- **委派**:Qwen 以 Function Calling(嵌套 `{"type":"function","function":{...}}` 格式)触发
  `delegate_to_claude`;hub 立即确认,随后把 Claude 的流式进度/最终总结作为 `input_text`
  项目注入会话转成语音(进度与总结自动去重,不重复播报)。Claude 跑在 `VOICE_WORKSPACE`
  沙箱,Write/Edit 限制在目录内,Bash 走白名单正则,其余操作拒绝并语音提示
- **会话持久化**:Claude 的 session id 落盘(`.claude-session-id`),hub 重启后自动
  `resume` 同一会话 —— 跨重启不忘记历史。`POST /api/reset-claude` 可主动清空
- **计费注意**:realtime 多轮会话的上下文(含历史帧)会在每个响应重复计费,默认 active 档

## 安全

- Key 只存本机 `.env`(页面仅掩码显示);不要把 `.env` 提交进任何仓库
- Claude 有目录级沙箱与命令白名单;语音触发的"批准流"在 roadmap

## License

MIT
