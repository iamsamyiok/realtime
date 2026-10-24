// Verdict test: does the model emit function_call events with our tools config?
// Tries nested format then flat format, logs every event type.
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });
import WebSocket from "ws";

const url = `wss://${process.env.DASHSCOPE_WORKSPACE_ID}.${process.env.QWEN_REGION ?? "cn-beijing"}.maas.aliyuncs.com/api-ws/v1/realtime?model=${process.env.QWEN_MODEL ?? "qwen3.8-omni-flash-realtime"}`;

const NESTED = [{
  type: "function",
  function: {
    name: "get_today_date",
    description: "获取今天的真实日期。凡是用户问日期、星期几,都必须调用此工具。",
    parameters: { type: "object", properties: {}, required: [] },
  },
}];
const FLAT = [{
  type: "function",
  name: "get_today_date",
  description: "获取今天的真实日期。凡是用户问日期、星期几,都必须调用此工具。",
  parameters: { type: "object", properties: {}, required: [] },
}];

function run(fmt, label) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}` }, handshakeTimeout: 10_000 });
    const seen = new Set();
    let fc = null;
    const timer = setTimeout(() => {
      console.log(`\n[${label}] TIMEOUT 30s. events seen:`, [...seen].join(", "));
      console.log(`[${label}] function_call:`, fc ? JSON.stringify(fc) : "NEVER FIRED");
      try { ws.close(); } catch {}
      resolve(fc);
    }, 30_000);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          turn_detection: { type: "semantic_vad" },
          tools: fmt,
        },
      }));
    });
    ws.on("message", (d) => {
      const ev = JSON.parse(d.toString());
      seen.add(ev.type);
      if (ev.type === "session.updated") {
        console.log(`[${label}] session.updated — sending text prompt`);
        ws.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text: "今天星期几?请用工具查询。" }] },
        }));
        ws.send(JSON.stringify({ type: "response.create" }));
      }
      if (ev.type === "response.function_call_arguments.done") {
        fc = { name: ev.name, call_id: ev.call_id, arguments: ev.arguments };
        clearTimeout(timer);
        console.log(`\n[${label}] FUNCTION CALL FIRED:`, JSON.stringify(fc));
        try { ws.close(); } catch {}
        resolve(fc);
      }
      if (ev.type === "response.done") {
        const items = ev.response?.output ?? [];
        for (const it of items) if (it.type === "function_call") {
          fc = { name: it.name, call_id: it.call_id, arguments: it.arguments };
          clearTimeout(timer);
          console.log(`\n[${label}] FUNCTION CALL (via done):`, JSON.stringify(fc));
          try { ws.close(); } catch {}
          resolve(fc);
        }
      }
      if (ev.type === "error") {
        clearTimeout(timer);
        console.log(`\n[${label}] ERROR:`, JSON.stringify(ev.error ?? ev).slice(0, 200));
        try { ws.close(); } catch {}
        resolve(null);
      }
      if (ev.type === "response.text.delta") process.stdout.write("");
    });
    ws.on("error", (e) => { clearTimeout(timer); console.log(`[${label}] ws error:`, e.message); resolve(null); });
  });
}

const nested = await run(NESTED, "nested-format");
if (!nested) {
  console.log("\nfalling back to flat format...");
  const flat = await run(FLAT, "flat-format");
  console.log("FINAL:", flat ? "flat works" : "neither format fired FC");
} else {
  console.log("FINAL: nested format works");
}
process.exit(0);
