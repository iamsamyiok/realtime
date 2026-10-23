// Sanity check for the Claude leg: Agent SDK streaming session round-trip.
import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env", import.meta.url).pathname });

import { query } from "@anthropic-ai/claude-agent-sdk";

const cwd = process.env.VOICE_WORKSPACE ?? "C:/Users/muxinyide/voice-workspace";
console.log("[test] cwd =", cwd);

async function* one(msg) { yield msg; }

const q = query({
  prompt: one({
    type: "user",
    message: { role: "user", content: "请只回复两个字:正常" },
    parent_tool_use_id: null,
  }),
  options: { cwd, permissionMode: "acceptEdits", maxTurns: 1, settingSources: [] },
});

let out = "";
for await (const m of q) {
  if (m.type === "assistant") {
    const blocks = m.message?.content ?? [];
    out += blocks.filter(b => b.type === "text").map(b => b.text).join("");
  } else if (m.type === "result") {
    out = String(m.result ?? out);
    console.log("[test] subtype:", m.subtype);
  }
}
console.log("[test] claude replied:", out.trim());
process.exit(out.trim().length > 0 ? 0 : 1);
