// PoC: raw-WS sanity check for the Qwen leg (run AFTER setting .env).
// Verifies: connect -> session.created -> session.update accepted ->
// audio append accepted -> image buffer accepts a frame -> FC tools config ok.
import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env", import.meta.url).pathname });

import WebSocket from "ws";

const key = process.env.DASHSCOPE_API_KEY;
const wsid = process.env.DASHSCOPE_WORKSPACE_ID;
if (!key || !wsid) {
  console.error("请在 voice-hub/.env 配置 DASHSCOPE_API_KEY 与 DASHSCOPE_WORKSPACE_ID");
  process.exit(1);
}
const url = `wss://${wsid}.${process.env.QWEN_REGION ?? "cn-beijing"}.maas.aliyuncs.com/api-ws/v1/realtime?model=${process.env.QWEN_MODEL ?? "qwen3.8-omni-flash-realtime"}`;
const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
};

const silence = Buffer.alloc(32000); // 1s of 16k PCM16 silence
let stage = 0;

ws.on("error", (e) => { check("connect", false, e.message); finish(); });
ws.on("message", (d) => {
  const ev = JSON.parse(d.toString());
  if (ev.type === "session.created") {
    check("connect + session.created", true);
    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        turn_detection: "semantic_vad",
        instructions: "测试会话",
        audio: {
          input: { format: { type: "pcm", sample_rate: 16000, sample_format: "s16le", channels: 1, packing: "interleaved", channel_layout: "mono" } },
          output: { voice: process.env.QWEN_VOICE ?? "Tina", format: { type: "pcm", sample_rate: 24000 } },
        },
      },
    }));
  } else if (ev.type === "session.updated") {
    if (stage === 0) {
      stage = 1;
      check("session.update (base) accepted", true);
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          tools: [{
            type: "function", name: "noop_test",
            description: "test tool",
            parameters: { type: "object", properties: {} },
          }],
          input_audio_transcription: { model: "gummy-realtime-v1" },
        },
      }));
    } else {
      check("session.update (tools + transcription)", true);
      // send 1s audio (establishes audio-first rule), then one image
      for (let o = 0; o < silence.length; o += 3200)
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: silence.subarray(o, o + 3200).toString("base64") }));
      // 1x1 white JPEG
      const jpg = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmgA//9k=", "base64");
      ws.send(JSON.stringify({ type: "input_image_buffer.append", image: jpg.toString("base64") }));
      setTimeout(() => {
        check("audio append + image append (no error event)", !results.some(r => !r.ok));
        finish();
      }, 1500);
    }
  } else if (ev.type === "error") {
    const msg = JSON.stringify(ev.error ?? ev).slice(0, 200);
    if (stage === 0) check("session.update (base)", false, msg);
    else if (stage === 1) check("session.update (tools + transcription)", false, msg);
    else check("audio/image append", false, msg);
    finish();
  }
});

function finish() {
  ws.close();
  console.log("\n---- PoC summary ----");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name} ${r.detail}`);
  process.exit(results.some(r => !r.ok) ? 1 : 0);
}
