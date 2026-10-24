// Debug: verify frames keep flowing into Qwen while a Claude task runs.
import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:8090/ws");
const samples = [];
let busySeen = false, doneAfterBusy = false;

ws.on("open", () => {
  console.log("WS open, dispatching small task...");
  ws.send(JSON.stringify({
    t: "text",
    text: "/c 在工作区创建 progress-demo.txt,写入三行文字即可,不要运行命令。",
  }));
  const timer = setInterval(async () => {
    try {
      const s = await (await fetch("http://localhost:8090/api/status")).json();
      const line = `busy=${s.claudeBusy ? 1 : 0} recv=${s.framesReceived} inj=${s.framesInjected}`;
      if (samples.length === 0 || line !== samples[samples.length - 1]) {
        samples.push(line);
        console.log(line);
      }
      if (s.claudeBusy) busySeen = true;
      else if (busySeen) { doneAfterBusy = true; }
      if (doneAfterBusy) {
        console.log("---- RESULT ----");
        console.log("frames injected during/after busy run:", s.framesInjected);
        console.log(s.framesInjected > 0 ? "PASS — vision stayed live during task" : "FAIL — no frames injected");
        process.exit(s.framesInjected > 0 ? 0 : 1);
      }
    } catch {}
  }, 2000);
});
ws.on("message", (d) => {
  try {
    const m = JSON.parse(d.toString());
    if (m.t === "progress") console.log("  ⏳", m.line.slice(0, 60));
    if (m.t === "agent_done") console.log("  ✅", m.summary.slice(0, 80));
  } catch {}
});
setTimeout(() => {
  console.log("TIMEOUT. busySeen=", busySeen);
  process.exit(1);
}, 120000);
