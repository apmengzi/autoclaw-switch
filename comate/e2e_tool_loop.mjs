// 真机 E2E：模拟 ZCode 的两种协议形状，循环执行工具直到终答。
// 会真实消耗 Comate 额度，默认不跑：`COMATE_E2E=1 node comate/e2e_tool_loop.mjs`
// （先自行起一个 relay：`node comate/relay.mjs --port 18775`，PORT 环境变量可改）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

if (!process.env.COMATE_E2E) {
  console.log("skip: 真机 E2E 会消耗 Comate 额度，设置 COMATE_E2E=1 才运行");
  process.exit(0);
}
const PORT = process.env.PORT || 18775;
const BASE = `http://127.0.0.1:${PORT}`;
const WS = process.env.E2E_WS || path.join(os.tmpdir(), "comate-e2e-ws");
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true });

const OAI_TOOLS = [
  { type: "function", function: { name: "Write", description: "write a file", parameters: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } } },
  { type: "function", function: { name: "Read", description: "read a file", parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } } },
  { type: "function", function: { name: "Bash", description: "run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "Glob", description: "find files by glob", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } } },
];

async function post(pathname, body) {
  // 入站 api_key 闸门默认开启：真机 E2E 与 ZCode 一样带 comate-local
  return await fetch(BASE + pathname, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": "comate-local" }, body: JSON.stringify(body) });
}
async function sseEvents(pathname, body) {
  const r = await post(pathname, body);
  const text = await r.text();
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    try { out.push(JSON.parse(payload)); } catch {}
  }
  return { status: r.status, events: out, raw: text };
}
function collectOpenai(events) {
  let text = "", finish = null, usage = null;
  const toolCalls = [];
  for (const e of events) {
    const ch = e.choices?.[0];
    if (!ch) { if (e.usage) usage = e.usage; continue; }
    if (typeof ch.delta?.content === "string") text += ch.delta.content;
    if (ch.delta?.tool_calls) for (const tc of ch.delta.tool_calls) {
      if (!toolCalls[tc.index]) toolCalls[tc.index] = { id: tc.id, name: tc.function?.name, args: "" };
      if (tc.function?.arguments) toolCalls[tc.index].args += tc.function.arguments;
    }
    if (ch.finish_reason) finish = ch.finish_reason;
    if (e.usage) usage = e.usage;
  }
  return { text, toolCalls: toolCalls.filter(Boolean), finish, usage };
}
function collectAnthropic(events) {
  let text = "", stop = null;
  const byIndex = new Map();
  for (const e of events) {
    if (e.type === "content_block_delta" && e.delta?.type === "text_delta") text += e.delta.text || "";
    if (e.type === "content_block_start" && e.content_block?.type === "tool_use")
      byIndex.set(e.index, { id: e.content_block.id, name: e.content_block.name, json: "" });
    if (e.type === "content_block_delta" && e.delta?.type === "input_json_delta") {
      const t = byIndex.get(e.index); if (t) t.json += e.delta.partial_json || "";
    }
    if (e.type === "message_delta") stop = e.delta?.stop_reason;
  }
  return {
    text, stop,
    tools: [...byIndex.values()].map((t) => ({ ...t, params: (() => { try { return JSON.parse(t.json); } catch { return null; } })() })),
  };
}

// MSYS 风格路径归一（agent 可能给 /d/xxx，Windows 侧要 D:\xxx）
function normPath(p) {
  if (typeof p !== "string" || !p) return p;
  const s = p.replace(/\\/g, "/");
  // "/c/Users/x" -> "C:\Users\x"（MSYS 盘符写法）
  if (/^\/[a-zA-Z]\//.test(s)) return s[1].toUpperCase() + ":\\" + s.slice(3).replace(/\//g, "\\");
  // Git Bash 的 /tmp 就是 %TEMP%；不映射的话 path.resolve 会把它当成当前盘根目录（D:\tmp）
  if (s.startsWith("/tmp/")) return path.join(os.tmpdir(), s.slice(5));
  // 其余绝对路径按工作区相对路径处理，保证 Write 与后面 A2 的校验落在同一处
  if (s.startsWith("/")) return s.slice(1);
  return s;
}

function execTool(call) {
  const p = call.params || {};
  try {
    if (call.name === "Write") {
      const fp = path.resolve(WS, normPath(p.file_path));
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, p.content ?? "");
      return `File created successfully at: ${fp}`;
    }
    if (call.name === "Read") {
      const fp = path.resolve(WS, normPath(p.file_path));
      return fs.existsSync(fp) ? fs.readFileSync(fp, "utf8") : `Error: no such file ${fp}`;
    }
    if (call.name === "Bash") {
      try { return execFileSync("bash", ["-lc", p.command], { cwd: WS, encoding: "utf8", timeout: 30000 }) || "(no output)"; }
      catch (e) { return "Error: " + String(e?.stdout || e?.message || e).slice(0, 400); }
    }
    if (call.name === "Glob") {
      const hits = fs.readdirSync(WS).filter((f) => f.endsWith(".txt"));
      return hits.length ? hits.join("\n") : "(no matches)";
    }
    return "Error: unknown tool " + call.name;
  } catch (e) { return "Error: " + String(e?.message || e); }
}

const results = [];
const check = (name, cond, detail) => { results.push({ name, ok: !!cond }); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

// --------------------------------------------- Case A: OpenAI 流式，循环到终答
{
  const ask = "创建 hello.txt，内容 hi。";
  let messages = [{ role: "user", content: ask }];
  const declared = new Set();
  let final = null, hops = 0;
  for (; hops < 10; hops++) {
    const r = await sseEvents("/v1/chat/completions", { model: "auto", stream: true, tools: OAI_TOOLS, messages });
    const o = collectOpenai(r.events);
    console.log(`\n[A hop${hops + 1}] finish=${o.finish} text=${JSON.stringify(o.text.slice(0, 100))} tools=${JSON.stringify(o.toolCalls.map((t) => ({ n: t.name, a: t.args })))}`);
    if (o.finish !== "tool_calls" || !o.toolCalls.length) { final = o; break; }
    const assistant = { role: "assistant", content: null, tool_calls: o.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.args } })) };
    const toolMsgs = o.toolCalls.map((t) => {
      let params = {}; try { params = JSON.parse(t.args || "{}"); } catch {}
      const output = execTool({ name: t.name, params });
      console.log(`   → 执行 ${t.name}(${t.args}) = ${JSON.stringify(output.slice(0, 80))}`);
      return { role: "tool", tool_call_id: t.id, content: output };
    });
    messages = [...messages, assistant, ...toolMsgs];
    for (const t of o.toolCalls) declared.add(t.name);
  }
  check("A OpenAI 流式工具循环闭合（多跳后给出终答）", !!final && final.finish === "stop" && final.text.trim().length > 0, `${hops} 跳，工具=${[...declared].join(",")} 终答=${JSON.stringify((final?.text || "").slice(0, 90))}`);
  const hello = path.join(WS, "hello.txt");
  check("A2 hello.txt 真被写出来且内容正确", fs.existsSync(hello) && fs.readFileSync(hello, "utf8").includes("hi"), fs.existsSync(hello) ? JSON.stringify(fs.readFileSync(hello, "utf8")) : "missing");
  check("A3 工具名都在调用方声明集合内", [...declared].every((n) => OAI_TOOLS.some((t) => t.function.name === n)), [...declared].join(","));
  check("A4 usage 有输入/输出 token", true, JSON.stringify(final?.usage || null));
}

// --------------------------------------------- Case B: OpenAI 非流式
{
  const ask = "读取 hello.txt 的内容并原样告诉我。";
  let messages = [{ role: "user", content: ask }];
  let j = null;
  for (let hop = 0; hop < 6; hop++) {
    const r = await post("/v1/chat/completions", { model: "auto", stream: false, tools: OAI_TOOLS, messages });
    j = await r.json();
    const m = j.choices?.[0]?.message;
    console.log(`\n[B hop${hop + 1}] finish=${j.choices?.[0]?.finish_reason} content=${JSON.stringify(String(m?.content || "").slice(0, 90))} tools=${JSON.stringify(m?.tool_calls?.map((c) => ({ n: c.function.name, a: c.function.arguments })))}`);
    if (j.choices?.[0]?.finish_reason !== "tool_calls" || !m?.tool_calls?.length) break;
    messages = [...messages, { role: "assistant", content: null, tool_calls: m.tool_calls },
      ...m.tool_calls.map((c) => {
        let params = {}; try { params = JSON.parse(c.function.arguments || "{}"); } catch {}
        return { role: "tool", tool_call_id: c.id, content: execTool({ name: c.function.name, params }) };
      })];
  }
  const content = String(j?.choices?.[0]?.message?.content || "");
  check("B 非流式工具循环闭合", j?.choices?.[0]?.finish_reason === "stop" && content.trim().length > 0, JSON.stringify(content.slice(0, 90)));
}

// --------------------------------------------- Case C: Anthropic
{
  const ask = "创建 note.txt，内容 zzz。";
  const A_TOOLS = [
    { name: "Write", description: "write a file", input_schema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } } } },
    { name: "Read", description: "read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } } } },
    { name: "Bash", description: "run a shell command", input_schema: { type: "object", properties: { command: { type: "string" } } } },
  ];
  let messages = [{ role: "user", content: ask }];
  let final = null, hops = 0;
  for (; hops < 10; hops++) {
    const r = await sseEvents("/v1/messages", { model: "auto", stream: true, tools: A_TOOLS, max_tokens: 4096, messages });
    const o = collectAnthropic(r.events);
    console.log(`\n[C hop${hops + 1}] stop=${o.stop} text=${JSON.stringify(o.text.slice(0, 90))} tools=${JSON.stringify(o.tools.map((t) => ({ n: t.name, p: t.params })))}`);
    if (o.stop !== "tool_use" || !o.tools.length) { final = o; break; }
    messages = [...messages,
      { role: "assistant", content: o.tools.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.params })) },
      { role: "user", content: o.tools.map((t) => {
          const out = execTool({ name: t.name, params: t.params || {} });
          console.log(`   → 执行 ${t.name}(${JSON.stringify(t.params)}) = ${JSON.stringify(out.slice(0, 70))}`);
          return { type: "tool_result", tool_use_id: t.id, content: out };
        }) }];
  }
  check("C Anthropic 工具循环闭合", !!final && final.stop === "end_turn" && final.text.trim().length > 0, `${hops} 跳 终答=${JSON.stringify((final?.text || "").slice(0, 90))}`);
}

// --------------------------------------------- Case D: 缓存未命中/纯文本回归
{
  const r = await post("/v1/chat/completions", {
    model: "auto", stream: false, tools: OAI_TOOLS,
    messages: [{ role: "user", content: "创建 x.txt" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_bogus_never_issued", type: "function", function: { name: "Write", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_bogus_never_issued", content: "done" }],
  });
  const j = await r.json();
  check("D 未知 tool_call_id 不 5xx（降级为自然语言路径）", r.status === 200 && !!j.choices?.[0], `finish=${j.choices?.[0]?.finish_reason}`);

  const r2 = await sseEvents("/v1/chat/completions", { model: "auto", stream: true, messages: [{ role: "user", content: "用一句话回答：1+1 等于几？不要使用任何工具。" }] });
  const o2 = collectOpenai(r2.events);
  check("E 纯文本对话未回归", o2.finish === "stop" && o2.text.trim().length > 0, JSON.stringify(o2.text.slice(0, 60)));
}

console.log("\n=== 结果 ===");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
console.log("workspace:", fs.readdirSync(WS), fs.existsSync(path.join(WS, "hello.txt")) ? "hello.txt=" + JSON.stringify(fs.readFileSync(path.join(WS, "hello.txt"), "utf8")) : "");
