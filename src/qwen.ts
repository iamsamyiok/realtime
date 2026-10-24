import WebSocket from "ws";
import { cfg, qwenWsUrl, buildInstructions, QWEN_TOOLS } from "./config.js";

export type QwenCallbacks = {
  /** base64 PCM 24kHz chunk to play on the browser */
  onAudio: (b64: string) => void;
  /** stop playback (user barged in) */
  onStopAudio: () => void;
  onTranscript: (who: "user" | "assistant", text: string, final: boolean) => void;
  onState: (state: "connecting" | "ready" | "closed" | "error", detail?: string) => void;
  onFunctionCall: (name: string, argsJson: string, callId: string) => Promise<unknown>;
  onSpeechActivity: (speaking: boolean) => void;
};

type PendingCall = { name: string; callId: string; args: string };

/**
 * One WebSocket session against Qwen3.8-Omni-Flash-Realtime.
 * Protocol facts per DashScope docs (refs/aliyun-realtime.txt):
 *  - session.update: modalities/turn_detection/audio{input,output}/instructions/tools
 *  - input_audio_buffer.append {audio: base64 PCM16 16k mono}
 *  - input_image_buffer.append {image: base64 JPEG}, <=190KB raw, 1fps, audio first
 *  - output: response.audio.delta (24k PCM), response.audio_transcript.delta
 *  - interruption: on speech_started -> response.cancel
 *  - FC result: conversation.item.create {item:{type:"function_call_output", call_id, output}}
 */
export class QwenSession {
  private ws: WebSocket | null = null;
  private closedByUs = false;
  private audioSent = false;
  private lastAudioAt = 0;
  private lastImageAt = 0;
  private responding = false;
  private pendingCalls = new Map<string, PendingCall>(); // by item_id
  private submittedCallIds = new Set<string>();
  private pendingRespondAfterDone = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private sessionGen = 0;
  private stageAConfirmed = false;

  constructor(private cb: QwenCallbacks) {}

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (!cfg.dashscopeKey) {
      this.cb.onState("error", "DASHSCOPE_API_KEY 未配置");
      return;
    }
    this.closedByUs = false;
    this.sessionGen++;      // function outputs from older generations are stale
    this.cb.onState("connecting");
    const ws = new WebSocket(qwenWsUrl(), {
      headers: { Authorization: `Bearer ${cfg.dashscopeKey}` },
      handshakeTimeout: 15_000,
    });
    this.ws = ws;

    ws.on("open", () => {
      this.audioSent = false;
      this.sendSessionConfig();
    });

    ws.on("message", (data) => {
      try {
        this.handleEvent(JSON.parse(data.toString()));
      } catch (e) {
        console.error("[qwen] bad event:", (e as Error).message);
      }
    });

    ws.on("error", (err) => {
      console.error("[qwen] ws error:", err.message);
      this.cb.onState("error", err.message);
    });

    ws.on("close", (code, reason) => {
      this.responding = false;
      this.cb.onState("closed", `${code} ${reason.toString().slice(0, 80)}`);
      if (!this.closedByUs) {
        console.log("[qwen] reconnecting in 3s...");
        setTimeout(() => !this.closedByUs && this.connect(), 3000);
      }
    });

    // Keepalive: prevents idle-timeout 1006 drops mid-conversation
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30_000);
    ws.on("close", () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
    });
  }

  close(): void {
    this.closedByUs = true;
    this.ws?.close();
    this.ws = null;
  }

  /** Drop the current session and reconnect with fresh settings. */
  reconnect(): void {
    this.closedByUs = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.stageAConfirmed = false;
    if (cfg.dashscopeKey && cfg.workspaceId) {
      this.closedByUs = false;
      setTimeout(() => this.connect(), 500);
    }
  }

  /** Two-stage config: base session first, then tools/transcription.
   *  Unknown fields would make the whole update fail, so a failed stage-B
   *  never takes down the working baseline (PoC-friendly).
   *  turn_detection shape is server-version dependent -> try a fallback
   *  ladder (object form, string form, null/manual). */
  private baseVariantIdx = 0;

  private static baseVariants(voice: string): any[] {
    const audio = {
      input: {
        format: {
          type: "pcm",
          sample_rate: 16000,
          sample_format: "s16le",
          channels: 1,
          packing: "interleaved",
          channel_layout: "mono",
        },
      },
      output: { voice, format: { type: "pcm", sample_rate: 24000 } },
    };
    return [
      { modalities: ["text", "audio"], turn_detection: { type: "semantic_vad" }, instructions: buildInstructions(), audio },
      { modalities: ["text", "audio"], turn_detection: "semantic_vad", instructions: buildInstructions(), audio },
      { modalities: ["text", "audio"], turn_detection: null, instructions: buildInstructions(), audio },
    ];
  }

  private sendSessionConfig(): void {
    const variants = QwenSession.baseVariants(cfg.qwenVoice);
    const v = variants[this.baseVariantIdx] ?? variants[0];
    console.log(`[qwen] sending base session config (variant ${this.baseVariantIdx + 1})`);
    this.send({ type: "session.update", session: v });
  }

  private sendStageB(): void {
    if (!this.stageAConfirmed) return;
    // Custom function tools: shape per OpenAI-realtime-like convention;
    // verify exact field names in PoC (refs checklist §11.1).
    this.send({
      type: "session.update",
      session: {
        tools: QWEN_TOOLS,
        input_audio_transcription: { model: "gummy-realtime-v1" },
      },
    });
  }

  send(obj: unknown): void {
    if (this.connected) this.ws!.send(JSON.stringify(obj));
  }

  sendAudioPcm16(chunk: Buffer): void {
    if (!this.connected) return;
    this.audioSent = true; // images require at least one audio packet first
    this.lastAudioAt = Date.now();
    for (let off = 0; off < chunk.length; off += 3200) {
      this.send({
        type: "input_audio_buffer.append",
        audio: chunk.subarray(off, off + 3200).toString("base64"),
      });
    }
  }

  /** Rate-limited (>=1s), size-checked (<=max) ambient image push.
   *  The server requires audio before images and appears to reset that
   *  state after idle periods -> send a short silence warm-up when needed. */
  maybeSendImage(jpeg: Buffer): "sent" | "skipped-size" | "skipped-rate" | "skipped-off" {
    if (!this.connected) return "skipped-off";
    const now = Date.now();
    // Server requires audio before images and resets that state when idle:
    // warm up with silence if we never sent audio or have been quiet a while.
    if (!this.audioSent || now - this.lastAudioAt > 30_000) {
      this.send({
        type: "input_audio_buffer.append",
        audio: Buffer.alloc(3200).toString("base64"), // 100ms silence @16k s16le
      });
      this.lastAudioAt = now;
      this.audioSent = true;
    }
    if (now - this.lastImageAt < 1000) return "skipped-rate";
    if (jpeg.length > cfg.qwenImageMaxBytes) return "skipped-size";
    this.lastImageAt = now;
    this.send({ type: "input_image_buffer.append", image: jpeg.toString("base64") });
    return "sent";
  }

  /** Inject a text item (progress notes, background info) without audio. */
  sendTextItem(text: string): void {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
  }

  requestResponse(): void {
    if (this.responding) {
      // one response at a time; re-issue when the current one finishes
      this.pendingRespondAfterDone = true;
      return;
    }
    this.send({ type: "response.create" });
  }

  /** Feed a finished tool call back (output is a plain readable string, per
   *  the official realtime FC example) and trigger the spoken summary. */
  submitFunctionOutput(callId: string, output: string): void {
    if (this.submittedCallIds.has(callId)) {
      console.log(`[qwen] duplicate function call output suppressed: ${callId}`);
      return;
    }
    this.submittedCallIds.add(callId);
    if (this.submittedCallIds.size > 200) this.submittedCallIds.clear();
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output,
      },
    });
    this.requestResponse();
  }

  private handleEvent(ev: any): void {
    switch (ev.type) {
      case "session.created":
        break;
      case "session.updated":
        if (!this.stageAConfirmed) {
          this.stageAConfirmed = true;
          console.log(`[qwen] base session confirmed (turn_detection variant ${this.baseVariantIdx + 1})`);
          this.cb.onState("ready");
          this.sendStageB();
        } else {
          console.log("[qwen] stage-B session confirmed (tools/transcription)");
        }
        break;

      case "input_audio_buffer.speech_started":
        this.cb.onSpeechActivity(true);
        // Official interruption pattern: cancel any in-flight response.
        if (this.responding) {
          this.responding = false;
          this.cb.onStopAudio();
          this.send({ type: "response.cancel" });
        }
        break;
      case "input_audio_buffer.speech_stopped":
        this.cb.onSpeechActivity(false);
        break;

      case "conversation.item.input_audio_transcription.completed":
        this.cb.onTranscript("user", ev.transcript ?? "", true);
        break;
      case "conversation.item.input_audio_transcription.delta":
        this.cb.onTranscript("user", (ev.text ?? "") + (ev.stash ?? ""), false);
        break;

      case "response.created":
        this.responding = true;
        break;

      case "response.output_item.added":
        if (ev.item?.type === "function_call") {
          const pending: PendingCall = {
            name: ev.item.name ?? "unknown",
            callId: ev.item.call_id ?? ev.item.id ?? "",
            args: "",
          };
          this.pendingCalls.set(ev.item.id, pending);
        }
        break;

      case "response.function_call_arguments.delta": {
        const p = this.pendingCalls.get(ev.item_id);
        if (p) p.args += ev.delta ?? "";
        break;
      }

      case "response.function_call_arguments.done": {
        const p =
          this.pendingCalls.get(ev.item_id) ??
          (ev.call_id
            ? { name: ev.name ?? "unknown", callId: ev.call_id, args: ev.arguments ?? "{}" }
            : undefined);
        if (p) void this.dispatchFunctionCall(p);
        this.pendingCalls.delete(ev.item_id);
        break;
      }

      case "response.audio.delta":
        this.cb.onAudio(ev.delta);
        break;

      case "response.audio_transcript.delta":
        this.cb.onTranscript("assistant", ev.delta, false);
        break;
      case "response.audio_transcript.done":
        this.cb.onTranscript("assistant", ev.transcript ?? "", true);
        break;

      case "response.done": {
        this.responding = false;
        // Defensive: catch function calls whose delta events we never saw.
        const items: any[] = ev.response?.output ?? [];
        for (const it of items) {
          if (it.type === "function_call" && !this.submittedCallIds.has(it.call_id)) {
            const already = [...this.pendingCalls.values()].some((p) => p.callId === it.call_id);
            if (!already && it.arguments) {
              void this.dispatchFunctionCall({
                name: it.name,
                callId: it.call_id,
                args: it.arguments,
              });
            }
          }
        }
        this.pendingCalls.clear();
        if (this.pendingRespondAfterDone) {
          this.pendingRespondAfterDone = false;
          setTimeout(() => this.requestResponse(), 150);
        }
        break;
      }

      case "error":
        console.error("[qwen] error event:", JSON.stringify(ev.error ?? ev).slice(0, 300));
        if (/Unknown function call id|rejected function_call_output/i.test(JSON.stringify(ev.error ?? ev))) {
          // Stale call_id from a previous session generation - already handled
          // by the text-injection fallback; never treat as fatal.
          break;
        }
        if (/append image before append audio/i.test(JSON.stringify(ev.error ?? ev))) {
          console.warn("[qwen] server reset audio state - will warm up with silence before next image");
          this.audioSent = false;
          break;
        }
        if (!this.stageAConfirmed && /session\.update|payload/i.test(JSON.stringify(ev.error ?? ev))) {
          this.baseVariantIdx++;
          const variants = QwenSession.baseVariants(cfg.qwenVoice);
          if (this.baseVariantIdx < variants.length) {
            console.log(`[qwen] base config rejected, trying variant ${this.baseVariantIdx + 1}/${variants.length}`);
            this.sendSessionConfig();
            break;
          }
          this.cb.onState("error", "所有 turn_detection 变体都被拒绝,请核对模型名/地域/权限");
        } else {
          this.cb.onState("error", ev.error?.message ?? "unknown error");
        }
        break;

      default:
        break;
    }
  }

  private async dispatchFunctionCall(p: PendingCall): Promise<void> {
    console.log(`[qwen] FC -> ${p.name} (${p.callId}) args=${p.args.slice(0, 120)}`);
    let args: any = {};
    try {
      args = p.args ? JSON.parse(p.args) : {};
    } catch {
      /* tolerate empty/partial arguments */
    }
    const gen = this.sessionGen;
    try {
      const output = await this.cb.onFunctionCall(p.name, JSON.stringify(args), p.callId);
      let text =
        typeof output === "string"
          ? output
          : Object.entries(output as Record<string, unknown>)
              .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
              .join("; ");
      text = text || "完成";
      if (gen !== this.sessionGen) {
        // The WS session dropped while the task ran: the old call_id no longer
        // exists server-side. Inject the result as plain text instead.
        console.log("[qwen] session regenerated - injecting tool result as text");
        this.sendTextItem(`[工具结果] ${text}`);
        this.requestResponse();
        return;
      }
      this.submitFunctionOutput(p.callId, text);
    } catch (e) {
      const msg = `执行失败: ${(e as Error).message}`;
      if (gen !== this.sessionGen) {
        this.sendTextItem(`[工具结果] ${msg}`);
        this.requestResponse();
      } else {
        this.submitFunctionOutput(p.callId, msg);
      }
    }
  }
}
