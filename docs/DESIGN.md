# VoiceBridge 设计文档 — Qwen Realtime 语音 × Claude Code × 摄像头

> 目标:全程不动电脑。对着麦克风说话 + 把物体举到 PC 摄像头前,Qwen 实时语音应答,
> 需要编程/执行时无缝委派给 Claude Code,结果语音播报。摄像头画面是双方共享的上下文。
>
> 状态:**v1 已实现**(代码在 `C:\Users\muxinyide\voice-hub`,运行手册见其 README)。
> 本文档为设计依据;下文"实现修正"章节记录了审查后与 v1 设计的差异。
> 日期:2026-10-23(实现:2026-10-24)

---

## 0. 实现修正(对照 v1 设计的审查结论)

以下差异来自对三份一手材料的逐条核对(Qwen 官方文档全文 / Agent SDK 0.3.309 类型定义 / mcp-webcam 源码):

1. **环境帧来源改为 hub 主动 MCP 轮询**(v1 设想的"客户端双画布补丁"不需要):
   hub 以 Streamable HTTP MCP 客户端身份连 `localhost:3333/mcp` 直接调 `capture`,
   帧双轨:原图 → Claude 附件,sharp 压缩 720P JPEG → Qwen(强制 ≤180KB,官方限 190KB)。
   mcp-webcam 服务端仅加 8 行 env 门控镜像转发(已提交本地 fork,可 PR)。
2. **FC 结果采用"立即确认 + 文本项进度注入"**,而非挂起 function_call_output 等任务跑完
   (任务可能几十分钟,协议不允许也不该长时间悬置一个 FC):
   delegate 立刻返回 `{status:"accepted"}`,Claude 的进度/结果经
   `conversation.item.create(input_text)` + `response.create` 逐条播报。
3. **计费关键事实(官方文档确认)**:多轮 realtime 会话中,上下文窗口内**所有历史音频/图片/文本
   在每个响应都会重新计为输入 Token** → 帧注入频率是第一成本杠杆,`FRAME_MODE=active` 为默认。
   输入音频 7 token/秒,输出 12.5 token/秒;MCP 工具调用不额外收费;联网搜索与 tools 互斥。
4. **Agent SDK 图像附件已确认**:SDKUserMessage.message 是完整 MessageParam,
   content 支持图像块(类型定义原文注明),delegate 时直接携带原图,无需走文件系统。
5. **会话配置采用两段式**:基础(modalities/turn_detection/audio/instructions)先确认,
   再发 tools + input_audio_transcription;若扩展段字段名与实际协议有出入,基础功能不受影响
   (官方文档只给了入口没给字段样例,详见 PoC 脚本)。
6. **打断**:官方模式 = `input_audio_buffer.speech_started` 时 `response.cancel` + 清空播放,
   已按此实现;Claude 任务的生命周期独立于语音回合,"停/取消"走 cancel_claude 工具或文字指令。

---

## 1. 体验定义(验收即按此)

| 场景 | 你做什么 | 系统行为 | 目标延迟 |
|---|---|---|---|
| 闲聊/提问 | 说话 | Qwen 直接语音回 | <1.5s 首响应 |
| "看看这是什么" | 把物体举到摄像头前 | Qwen 看着实时画面语音回答 | <2s |
| "把这个报错修一下" | 说话(可同时举着屏幕/电路板) | Qwen 委派 Claude Code → 期间语音播报进度 → 完成后总结 | 首播报 <2s,任务时长取决于 Claude |
| 打断 | 任何时刻插话 | 语音立即响应;可叫停 Claude 任务 | <0.5s |
| 指代延续 | "再加个测试" | Claude 长会话保持上下文,无需重复 | — |

## 2. 官方文档已核实的技术事实

来源:阿里云百炼《Qwen-Omni-Realtime》文档(help.aliyun.com/zh/model-studio/realtime),已抓取全文核对。

| 项 | 事实 |
|---|---|
| 推荐模型 | `qwen3.8-omni-flash-realtime`(另有 Qwen3.5-Omni-Realtime 系) |
| 接入协议 | WebSocket / WebRTC / AOQ 三选;**v1 用 WebSocket**(服务端集成、事件控制最全) |
| WS 地址 | `wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=…`(新加坡同理),Header `Authorization: Bearer $DASHSCOPE_API_KEY` |
| 音频输入 | `input_audio_buffer.append`(base64 PCM 16bit LE 单声道;示例输入 16kHz) |
| 断句 | `turn_detection: server_vad / semantic_vad / manual`;**semantic_vad 可滤附和声与背景音,推荐** |
| 图像输入 | `input_image_buffer.append`(base64 **JPG**);单张 base64 后 ≤256KB(原图 ≤190KB);**推荐 480P/720P,最高 1080P**;建议 1 张/秒;**须先发过至少一次音频**;连续视频缓冲语义(不是离散会话条目) |
| 文本注入 | `conversation.item.create`(input_text)——system 指令、背景信息、**function_call_output** 都走这里 |
| 音频输出 | `response.audio.delta`(base64 **24kHz** PCM),文本轨迹 `response.audio_transcript.delta`,结束 `response.done` |
| Function Calling | **支持自定义 FC**;**还支持挂远程 MCP 工具**与联网搜索 |
| 音色 | 默认 Tina,可多选,支持声音复刻 |
| WebRTC 模式 | 浏览器直连,UDP,内置回声消除+降噪(v2 备选) |

## 3. 总体架构

```
┌─ 浏览器(voice-front.html, localhost:8090) ─────────────┐
│  getUserMedia(echoCancellation, noiseSuppression)        │
│  PCM16k 上行 ──WS──┐          ┌──WS── 24kHz PCM 下行播放 │
└────────────────────┼──────────┼──────────────────────────┘
                     ▼          ▲
        ┌────────── voice-hub (Node.js, 本机) ─────────────┐
        │  MicPipe      QwenSession      ClaudeSession      │
        │  (音频搬运)    (WS客户端)       (Agent SDK 流式)   │
        │       ▲             ▲   ▲            ▲             │
        └───────┼─────────────┼───┼────────────┼─────────────┘
                │             │   │            │
   POST /frame  │   input_image│   │ FC调用      │ 文本+帧
                │   _buffer    │   │ delegate    │
                │             │   ▼            │
┌───────────────┴──┐   ┌──────┴───────┐   ┌────┴─────────────┐
│ mcp-webcam(本地) │   │ Qwen3.8-Omni │   │ Claude Code       │
│ 浏览器页:PC摄像头 │   │ -Flash-      │   │ (长会话,沙箱权限) │
│ 自动抓帧→POST     │   │ Flash-Realtime│   │ 编程/执行/MCP      │
└──────────────────┘   │ (DashScope)  │   └──────────────────┘
                       └──────────────┘
```

组件交付物:
1. `voice-hub/` — Node.js 中枢(唯一的新服务,端口 8090)
2. `voice-hub/public/voice-front.html` — 语音前端单页
3. `mcp-webcam` 补丁 — server.ts 加 ~15 行帧转发(已有本地 fork)
4. 无需改 Claude Code 本体 — 通过 Agent SDK 驱动

## 4. 组件详细设计

### 4.1 voice-hub(中枢)

单进程 Node.js + TypeScript,内部四个模块 + 一个状态机。

**QwenSession**:管理与 DashScope 的 WS。职责:
- 建连(指数退避重连);`session.update` 下发:modalities=[text,audio]、turn_detection=semantic_vad、输入 16kHz/输出 24kHz PCM、voice、system instructions(见 §5 人设)
- 上行:转发浏览器音频;按帧率策略注入 `input_image_buffer.append`;FC 结果用 `conversation.item.create` 回填
- 下行事件分拣 → EventBus(音频 delta → MicPipe 播放;文本 delta → 日志+UI;response.function_call_arguments.done → ClaudeSession)

**FrameBus**:接收 `POST /frame`(mcp-webcam 转发来的 JPEG)。三路分发:
- `ambient`:降采样至 1280×720、JPEG q70(控制 ≤150KB)→ 按 §4.3 策略注入 Qwen
- `latest`:全分辨率原图暂存,供 Claude 消息附件
- `journal`:JSONL 落盘(事件总线)

**ClaudeSession**:基于 `@anthropic-ai/claude-agent-sdk` 的**常驻流式会话**:
- 任务到达时组装消息:`[{type:"text", text:任务+上下文摘要}, {type:"image", source:latest}]`
- 流式事件里的助手文本增量 → 截短句推给 Qwen 播进度
- `AbortController` 支持语音叫停("停下")
- 会话常驻 → 指代("刚才那个函数")天然可用;每 N 轮自动 `/compact` 防溢出

**状态机**:`IDLE → LISTENING → (Qwen直接应答 | AGENT_RUNNING) → LISTENING`
- AGENT_RUNNING 中仍保持语音对话(Qwen 播进度、答旁枝问题)
- 语义"停/取消" → abort Claude;新委派到达且 Claude 忙 → 排队或询问(默认排队+播报)

### 4.2 语音前端页(voice-front.html)

- `getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, sampleRate:16000}})`
- AudioWorklet 降采样→PCM16→WS 二进制上行(hub 转发进 Qwen 音频缓冲)
- 收 `response.audio.delta` → base64→PCM → 播放队列(24kHz)
- 页面同时显示:状态灯、最近转写、Claude 任务进度、最新一帧画面缩略
- 开放问题:echoCancellation 处理 TTS 自激;若不够,音频前端改走 **WebRTC 直连 Qwen**(内置 AEC,见 §11 PoC-3)

### 4.3 视觉管线

mcp-webcam `server.ts` 补丁(本地 fork):在浏览器上传帧的处理分支里,同步 `fetch("http://127.0.0.1:8090/frame", {jpeg})`。帧来源两种:
- 手动(用户说"看")→ 现有 capture 流程
- **常驻**:复用页面已有的 Auto-update(最短 5s),hub 端缓冲后按 1fps 节流注入

注入策略(成本控制核心):

| 模式 | 触发 | 规格 | 目的 |
|---|---|---|---|
| 环境流 | 仅 LISTENING 且检测到语音活动(或每 5s 一张低速档) | 720P JPEG q70,1fps | "看见你在举什么" |
| 精看 | 用户说"仔细看/这是什么" 或 Qwen 调 `look_closely` | 抓 3 张连拍(全分辨率) | 供 Qwen 细看 + Claude 存档 |
| Claude 附件 | 每次 delegate 附当前 latest | 原生分辨率(修好后最高 2560×1440) | Claude 精确视觉 |

### 4.4 委派协议(FC 工具定义)

```jsonc
// session.update 的 tools 数组
[
 { "type":"function", "name":"delegate_to_claude",
   "description":"编程、改代码、跑命令、查文件、复杂分析等实际动手任务。闲聊/看图问答不要调用。",
   "parameters":{ "type":"object",
     "properties":{
       "task":{"type":"string","description":"清晰的任务描述,含从视觉/对话中提炼的关键信息"},
       "priority":{"type":"string","enum":["now","queue"]}
     }, "required":["task"] } },
 { "type":"function", "name":"look_closely",
   "description":"需要比当前画面更清晰的视觉细节时调用,将触发高分辨率连拍",
   "parameters":{ "type":"object","properties":{} } }
]
```

委派执行:`QwenSession` 收到 function_call → `ClaudeSession.send(task, latestFrame)` → 完成后把 Claude 的最终答复 + 关键过程摘要,经 `conversation.item.create(function_call_output)` 回填,Qwen 用自己的话语音总结。**Qwen 始终是"对话人格",Claude 是"执行体"——用户只和一个声音说话。**

系统指令(system instructions)要点(写入 session.update):
> 你是用户的工作伙伴,能看到他的摄像头实时画面。用户双手经常离开键盘,所有回复必须语音友好(短句、无列表无代码)。涉及编程/文件/命令时调用 delegate_to_claude,把屏幕上看到的错误信息一并写进 task。用户举起物体问"这是什么"时直接看图回答。Claude 执行期间你负责播报进度、陪聊、接打断。

### 4.5 上下文总线与记忆

- `journal.jsonl`:每事件一行 `{ts, kind, payload}`,kind ∈ user_speech / qwen_reply / frame / fc_call / claude_delta / claude_done / error
- Qwen 侧:靠其会话窗口 + 每 20 轮用 `conversation.item.create` 注入一条摘要
- Claude 侧:SDK 会话自维护;hub 在 delegate 的 task 里附"最近 3 轮对话摘要 + 最新帧",解决两边记忆不同步
- 重启恢复:journal 重放最后 N 条给两边做热身

## 5. 关键时序

**T1 闲聊+看图**:`语音→VAD断句→Qwen(含刚注入的帧)→response.audio.delta→播放`,全程不惊动 Claude。

**T2 看着电路板问"这个电容焊对了吗,顺便把测试跑了"**:
1. 帧(电路板)已注入 → Qwen 看图 → 触发 `delegate_to_claude(task="判断摄像头画面中电容焊接…并运行 npm test",priority="now")`
2. hub → ClaudeSession(附全分辨率帧)→ Claude 调 webcam MCP 再抓一张细看 / 分析 / 跑测试
3. Claude 流式进度("我先放大看了电容方向…")→ hub 截短句 → `conversation.item.create` → Qwen 播报
4. `claude_done` → function_call_output 回填 → Qwen:"焊对了,测试 12 个全过"

**T3 打断**:Claude 跑长命令时用户说"先别跑了,先回答我 XX" → semantic_vad 断句 → Qwen 直接应答(不经过 FC);若语义是取消 → hub abort Claude,播报已取消。

## 6. 事件映射表(实现对照)

| Qwen 事件 | hub 动作 |
|---|---|
| session.created / session.updated | 状态机 READY;下发 tools+instructions |
| input_audio_buffer.speech_started | 状态 LISTENING;暂停 Claude 进度播报(让路) |
| input_audio_buffer.committed | 断句完成 |
| response.audio.delta | base64→PCM→前端播放 |
| response.audio_transcript.delta | 日志/UI |
| response.function_call_arguments.done | → ClaudeSession;先语音播"交给 Claude 了" |
| response.done | 回合结束;恢复帧注入节流 |
| error | 日志+降级(重连/语音提示) |

| Claude SDK 事件 | hub 动作 |
|---|---|
| assistant message delta | 抽短句→进度播报(2s 节流) |
| tool_use(webcam capture 等) | 放行(已装 MCP) |
| result | 最终答复→function_call_output 回填 Qwen |

## 7. 安全与权限(免手操的底线)

- Claude 运行在**专用项目目录** `~/voice-workspace/`,Agent SDK 权限:allowlist(`Read/Glob/Grep` 全放行;`Bash` 仅 npm/git 只读类;`Edit/Write` 仅限该目录)→ 语音驱动的误操作半径受限
- 不使用 `--dangerously-skip-permissions`;未列入 allowlist 的操作 → Claude 返回"需要确认" → Qwen 语音向用户请求批准 → 用户说"同意" → hub 临时放行该一次操作(实现为 permission callback)
- DashScope key / Anthropic 凭证只进环境变量;journal 里不落 key
- 隐私告知:音频+画面将上行至阿里云与 Anthropic,敏感场景先说"停止看"→ hub 停止帧注入

## 8. 成本模型与控制

- Qwen:按音频时长 + 图像 token 计费(单价以百炼控制台为准);图像是大头 —— 1fps 常驻 ≈ 3600 张/时,不可接受,故 §4.3 的"语音活动时才注入 + 低速档"是默认;粗算活跃使用 1h ≈ 数百张帧 + ~30min 音频
- Claude:正常 CLI 计费;长会话 + /compact 控制上下文
- hub 提供环境变量一档旋钮:`FRAME_MODE=off|active|always`

## 9. 部署与运行

```
~/voice-workspace/        # Claude 沙箱项目目录
~/qwen-claude-voice/      # voice-hub 代码
  .env                    # DASHSCOPE_API_KEY, WORKSPACE_ID, ANTHROPIC 凭证
  npm run start           # 起 hub(8090) + 自动拉起 mcp-webcam(3333)
浏览器开两个页:localhost:3333(PC 摄像头抓帧)+ localhost:8090(语音)
```

前置:Node ≥20、DashScope key(北京地域)+ Workspace ID、Claude Code 已登录、mcp-webcam 本地 fork 已构建(已完成)。

## 10. 分期实施与验收

| 期 | 内容 | 验收 |
|---|---|---|
| M0(0.5天) | PoC:裸 WS 直连 Qwen,麦克风音频进、喇叭出;验证 semantic_vad 与 1fps 注图 | 能连续对话,能"看见"举起的物体 |
| M1(1天) | mcp-webcam 帧转发补丁 + hub FrameBus + voice-front | 举物提问全链路,无需手操 |
| M2(1天) | FC 委派 + ClaudeSession + 进度播报 + 叫停 | "看着报错帮我修"全程语音完成 |
| M3(0.5天) | 摘要记忆、批准流、journal 重放、旋钮 | 指代任务可续;权限外操作有语音确认 |

## 11. 风险与待 PoC 验证清单(拿 key 后第一件事)

1. **FC 事件细节**:function_call 参数是否分片(delta)聚合、function_call_output 的确切 item 结构 —— 文档确认了能力与入口,字段样例需实连验证
2. **图像缓冲与会话语义**:input_image_buffer 的帧是否进入可回指的上下文("刚才那个东西"指代距离多远);FC 期间是否仍接受帧
3. **音频格式组合**:输入 16k/输出 24k 与 session.update 的 audio 字段实际取值
4. **AEC 实测**:免提场景 TTS 是否触发自激;决定 v2 是否切 WebRTC 直连(内置 AEC,但需验证 WebRTC 模式下图像/FC 的通道)
5. **限流**:并发与 QPS 限额(控制台确认),决定帧率上限
6. **remote MCP 工具路线**:文档称 Qwen 可挂远程 MCP —— 未来可让 Qwen 直接调 mcp-webcam/或一个 claude-wrapper MCP,是当前 FC 委派的替代架构(PoC 后择优)

## 12. 参考资料

- 百炼 Qwen-Omni-Realtime 文档:https://help.aliyun.com/zh/model-studio/realtime (全文已抓取核对:`qwen-claude-voice/refs/aliyun-realtime.txt`)
- Claude Agent SDK:https://docs.claude.com/en/api/agent-sdk/typescript
- mcp-webcam 本地 fork(含修复):`C:\Users\muxinyide\mcp-webcam`
- 上游 PR:https://github.com/evalstate/mcp-webcam/pull/8
