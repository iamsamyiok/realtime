// Replicates the hub's exact two-stage config, then bisects which part of
// stage-B (tools+transcription together) breaks function calling.
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });
import WebSocket from "ws";
import { QWEN_INSTRUCTIONS, QWEN_TOOLS } from "../dist/config.js";

const url = `wss://${process.env.DASHSCOPE_WORKSPACE_ID}.${process.env.QWEN_REGION ?? "cn-beijing"}.maas.aliyuncs.com/api-ws/v1/realtime?model=${process.env.QWEN_MODEL ?? "qwen3.8-omni-flash-realtime"}`;

function trial(label, stageA, stageB) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}` }, handshakeTimeout: 10_000 });
    let updated = 0, fired = false;
    const timer = setTimeout(() => {
      console.log(`[${label}] TIMEOUT. fired=${fired} updates=${updated}`);
      try { ws.close(); } catch {}
      resolve(fired);
    }, 35_000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "session.update", session: stageA })));
    ws.on("message", (d) => {
      const ev = JSON.parse(d.toString());
      if (ev.type === "session.updated") {
        updated++;
        if (updated === 1 && stageB) {
          ws.send(JSON.stringify({ type: "session.update", session: stageB }));
          return;
        }
        console.log(`[${label}] config done (${updated} updates) — prompting`);
        ws.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text: "今天星期几?请用工具查询。" }] },
        }));
        ws.send(JSON.stringify({ type: "response.create" }));
      }
      if (ev.type === "response.function_call_arguments.done" && !fired) {
        fired = true;
        clearTimeout(timer);
        console.log(`[${label}] ✅ FC FIRED:`, ev.name, ev.call_id);
        try { ws.close(); } catch {}
        resolve(true);
      }
      if (ev.type === "response.done" && !fired) {
        for (const it of ev.response?.output ?? []) {
          if (it.type === "function_call") {
            fired = true; clearTimeout(timer);
            console.log(`[${label}] ✅ FC FIRED (done):`, it.name);
            try { ws.close(); } catch {}
            resolve(true);
          }
        }
      }
      if (ev.type === "error") {
        clearTimeout(timer);
        console.log(`[${label}] ❌ ERROR:`, JSON.stringify(ev.error ?? ev).slice(0, 180));
        try { ws.close(); } catch {}
        resolve(false);
      }
    });
    ws.on("error", (e) => { clearTimeout(timer); console.log(`[${label}] ws error:`, e.message); resolve(false); });
  });
}

const audio = {
  input: { format: { type: "pcm", sample_rate: 16000, sample_format: "s16le", channels: 1, packing: "interleaved", channel_layout: "mono" } },
  output: { voice: process.env.QWEN_VOICE ?? "Tina", format: { type: "pcm", sample_rate: 24000 } },
};
const stageA = {
  modalities: ["text", "audio"],
  turn_detection: { type: "semantic_vad" },
  instructions: QWEN_INSTRUCTIONS,
  audio,
};

// Trial 1: exact hub replica (stage B = tools + transcription)
const hubLike = await trial("hub-replica(tools+transcription)", stageA, {
  tools: QWEN_TOOLS,
  input_audio_transcription: { model: "gummy-realtime-v1" },
});
if (hubLike) { console.log("\nRESULT: hub config works — issue elsewhere"); process.exit(0); }

// Trial 2: tools only, no transcription
const toolsOnly = await trial("tools-only", stageA, { tools: QWEN_TOOLS });
if (toolsOnly) { console.log("\nRESULT: transcription field breaks tools!"); process.exit(0); }

// Trial 3: single-update (tools inside stage A)
const single = await trial("single-update", { ...stageA, tools: QWEN_TOOLS }, null);
console.log("\nRESULT:", single ? "single-update works — two-stage split breaks tools" : "all trials failed");
process.exit(0);
