// Memory persistence test: phase 1 teaches a secret, phase 2 resumes the
// session in a brand-new process and asks for it back.
import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";

const cwd = "C:/Users/muxinyide/voice-workspace";
const idFile = "C:/Users/muxinyide/voice-hub/.test-session-id";
const phase = process.argv[2] ?? "1";

async function run(prompt, resumeId) {
  let sid = "", out = "";
  const q = query({
    prompt,
    options: {
      cwd,
      maxTurns: 1,
      settingSources: [],
      ...(resumeId ? { resume: resumeId } : {}),
    },
  });
  for await (const m of q) {
    if (m.session_id) sid = m.session_id;
    if (m.type === "result") out = String(m.result ?? "");
  }
  return { sid, out };
}

if (phase === "1") {
  const { sid, out } = await run("请记住这个暗号:菠萝42。只回复两个字:收到", undefined);
  fs.writeFileSync(idFile, sid, "utf8");
  console.log("phase1 reply:", out.trim().slice(0, 30), "| session:", sid.slice(0, 8));
  console.log("phase1 PASS:", /收到/.test(out) ? "yes" : "no");
} else {
  const sid = fs.readFileSync(idFile, "utf8").trim();
  console.log("phase2 resuming session:", sid.slice(0, 8));
  const { out } = await run("我之前告诉你的暗号是什么?只回复暗号本身。", sid);
  console.log("phase2 reply:", out.trim().slice(0, 40));
  console.log("phase2 PASS:", /菠萝42/.test(out) ? "yes — memory persisted across processes" : "NO");
}
