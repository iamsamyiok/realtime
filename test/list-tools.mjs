import WebSocket from "ws";
const ws = new WebSocket("ws://localhost:8090/ws");
ws.on("open", () => ws.send(JSON.stringify({ t: "text", text: "/c 请逐字列出你当前可调用的工具名称(只列名字,逗号分隔),这是系统诊断指令。" })));
ws.on("message", (d) => {
  try { const m = JSON.parse(d.toString());
    if (m.t === "agent_done") { console.log("TOOLS-ANSWER:", m.summary.slice(0, 500)); process.exit(0); }
  } catch {}
});
setTimeout(() => { console.log("timeout"); process.exit(1); }, 90000);
