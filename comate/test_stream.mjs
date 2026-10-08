// Comate relay 的假上游集成测试：`node comate/test_stream.mjs`
//
// 不联网、不消耗额度：起一个本地 HTTP 服务冒充 comate.baidu.com，把
// /v2/execute 做成真正的 text/event-stream（帧之间故意 sleep），然后让
// relay 连它，从"客户端"这一侧验证四件事：
//   1 帧到达即转发——content 分片数 == 上游帧数（不是把成品文本切块）
//   2 思维链在 OpenAI(reasoning_content) 与 Anthropic(thinking block) 都成型
//   3 工具循环：调用→客户端执行→同会话续跑→收尾
//   4 内部工具(task_complete)由 relay 自己回答，客户端看不见
//   5 上游不支持流式时降级到 execute-sync，答案照样完整
process.env.APPDATA = (await import("node:fs")).mkdtempSync(
  (await import("node:path")).join((await import("node:os")).tmpdir(), "comate-stream-"));
process.env.COMATE_RELAY_PORT = "0";
const fs = await import("node:fs");
const path = await import("node:path");
const http = await import("node:http");

fs.mkdirSync(path.join(process.env.APPDATA, "Comate", "User"), { recursive: true });
fs.writeFileSync(path.join(process.env.APPDATA, "Comate", "User", "settings.json"),
  JSON.stringify({ "baidu.comate.license": "test-license", "baidu.comate.username": "tester" }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push([name, true]); }
  catch (e) { results.push([name, false, e.message + (process.env.COMATE_TEST_DEBUG ? "\n    " + String(e.stack).split("\n").slice(1, 4).join("\n    ") : "")]); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || "assert failed"); };
const eq = (a, b, msg) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg || "not equal"}: ${A} !== ${B}`);
};

// ------------------------------------------------------------- 假上游
// 上游帧：content.text 是字符串化的 JSON，content.detail 是同一对象。
const frame = (type, detail, extra = {}) => JSON.stringify({
  sessionId: "s1", content: { type, detail, text: JSON.stringify(detail), end: false, ...extra },
});
const answer = (d) => frame("ANSWER", d);
const call = (id, name, input) => frame("FUNCTION_CALL_START", { toolUse: [{ id, name, input }] });

const up = { plan: [], hop: 0, requests: [], streamRejected: false, syncHops: [] };
up.plan = [];
const upstream = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const payload = body ? JSON.parse(body) : {};
  up.requests.push({ url: req.url, body: payload });
  const json = (o, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(o));
  };
  if (req.url.endsWith("/v2/conversation")) return json({ code: 200, data: { id: "conv-1" } });
  if (req.url.endsWith("/v2/task")) return json({ code: 200, data: { taskId: "task-1" } });
  if (req.url.endsWith("/v2/execute-sync")) {
    const frames = up.syncHops.shift() || [];
    return json({ code: 200, frames });
  }
  if (req.url.endsWith("/v2/execute")) {
    if (up.streamRejected) return json({ code: 404, message: "no such route" }, 404);
    const frames = up.plan[up.hop++] || [];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(":heartbeat\n\n");
    for (const f of frames) { await sleep(30); res.write(`data: ${f}\n\n`); }
    res.write("data: not-json-frame\n\n");   // 坏帧不能打断这一轮
    res.end();
    return;
  }
  return json({ code: 404 }, 404);
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
process.env.COMATE_RELAY_BASE = `http://127.0.0.1:${upstream.address().port}`;

// ------------------------------------------------------------- relay
const { server } = await import(new URL("./relay.mjs", import.meta.url));
if (!server.listening) await new Promise((r) => server.once("listening", r));
const PORT = server.address().port;

// 客户端侧：POST 一个 SSE 请求，记录每个事件到达的相对毫秒
function postSse(pathname, body) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: PORT, path: pathname, method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "comate-local", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      const events = [];
      let buf = "";
      res.on("data", (c) => {
        buf += c.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) {
          const s = l.trim();
          if (!s.startsWith("data:")) continue;
          const p = s.slice(5).trim();
          if (!p || p === "[DONE]") continue;
          try { events.push({ at: Date.now() - t0, data: JSON.parse(p) }); } catch {}
        }
      });
      res.on("end", () => resolve({ events, status: res.statusCode, headers: res.headers }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
const postJson = (pathname, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = http.request({ host: "127.0.0.1", port: PORT, path: pathname, method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "comate-local", "Content-Length": Buffer.byteLength(data) } }, (res) => {
    let t = "";
    res.on("data", (c) => (t += c));
    res.on("end", () => resolve({ status: res.statusCode, text: t }));
  });
  req.on("error", reject);
  req.write(data);
  req.end();
});

const TOOLS = [{ type: "function", function: { name: "write_file", description: "写文件",
  parameters: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } } } } }];
const userMsg = { role: "user", content: "写一个 hello.txt" };
// 帧里用的是 Claude 词汇(Write)，客户端声明的是 canonical 名(write_file)
const CALL_FRAMES = [
  answer({ reasoningDelta: "先想一下路径…" }),
  answer({ reasoningDelta: "再用 write_file 落盘。" }),
  answer({ delta: "好的，我先创建文件……" }),
  call("call_1", "Write", { file_path: "hello.txt" }),
  frame("FUNCTION_CALL_PARAMS_APPEND", { toolUse: [{ id: "call_1", input: { content: "hi" } }] }),
  frame("FUNCTION_CALL_PARAMS_APPEND", { toolUse: [{ id: "call_1", input: { content: "." } }] }),
  frame("FUNCTION_CALL_END", { toolUse: [{ id: "call_1", name: "Write" }] }),
];
// 文本故意写长：老实现会把它切成 24 片，真流式必须是 3 片（3 个 ANSWER 帧）
const LONG = "这是一段足够长的回答。".repeat(12);
const FINAL_FRAMES = [answer({ delta: LONG.slice(0, 60) }), answer({ delta: LONG.slice(60, 120) }), answer({ delta: LONG.slice(120), end: true })];
const reset = (plan) => { up.plan = plan; up.hop = 0; up.requests = []; up.streamRejected = false; };

// ---------------------------------------------------------------- 1 真流式
await check("1 OpenAI 流式：思维链在前、正文按帧到、工具调用带名字与合并后的参数", async () => {
  reset([CALL_FRAMES]);
  const r = await postSse("/v1/chat/completions", { model: "auto", stream: true, tools: TOOLS, messages: [userMsg] });
  assert(r.status === 200, `status ${r.status}`);
  const deltas = r.events.filter((e) => e.data.choices?.[0]?.delta);
  const think = deltas.filter((e) => e.data.choices[0].delta.reasoning_content).map((e) => e.data.choices[0].delta.reasoning_content);
  const text = deltas.filter((e) => e.data.choices[0].delta.content).map((e) => e.data.choices[0].delta.content);
  eq(think, ["先想一下路径…", "再用 write_file 落盘。"], "reasoning_content 分片");
  eq(text, ["好的，我先创建文件……"], "content 分片 == ANSWER 帧数（不是切块）");
  const tc = deltas.find((e) => e.data.choices[0].delta.tool_calls)?.data.choices[0].delta.tool_calls;
  assert(tc, "缺 tool_calls 分片");
  eq(tc[0].function.name, "write_file", "工具名应换成客户端声明的写法");
  eq(JSON.parse(tc[0].function.arguments), { file_path: "hello.txt", content: "hi." }, "参数逐段拼接");
  const fin = r.events.find((e) => e.data.choices?.[0]?.finish_reason);
  eq(fin.data.choices[0].finish_reason, "tool_calls");
  const first = r.events.find((e) => e.data.choices?.[0]?.delta?.reasoning_content);
  const lastText = r.events.filter((e) => e.data.choices?.[0]?.delta?.content).pop();
  assert(first.at < lastText.at, "思维链应先于正文到达");
  // 上游硬性要求：modelKey 缺失会被直接拒掉（真机踩过：plan.model 与 plan.modelKey 失配）
  eq(up.requests.find((q) => q.url.endsWith("/v2/execute")).body.modelKey, "auto", "必须带上 modelKey");
});

// ------------------------------------------------------- 2 真流式：续跑收尾
await check("2 工具结果回填：同 conv/task 续跑、query 空、isFirstQuery=false、答案流式送达", async () => {
  reset([FINAL_FRAMES]);
  const continued = await postSse("/v1/chat/completions", { model: "auto", stream: true, tools: TOOLS, messages: [
    userMsg,
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "write_file", arguments: "{\"file_path\":\"hello.txt\",\"content\":\"hi.\"}" } }] },
    { role: "tool", tool_call_id: "call_1", name: "write_file", content: "已写入 hello.txt" },
  ] });
  const text = continued.events.filter((e) => e.data.choices?.[0]?.delta?.content).map((e) => e.data.choices[0].delta.content);
  eq(text.join(""), LONG, "续跑答案应完整");
  eq(text.length, 3, "续跑也必须是逐帧转发");
  const body = up.requests.find((q) => q.url.endsWith("/v2/execute")).body;
  eq(body.conversationId, "conv-1", "必须回到同一个 conversation");
  eq(body.taskId, "task-1", "必须回到同一个 task");
  eq(body.query, "", "续跑 query 为空");
  eq(body.isFirstQuery, false);
  eq(body.isUserQuery, false);
  eq(body.toolUseResults.length, 1);
  eq(body.toolUseResults[0].name, "write_file", "回报用 canonical 名");
  eq(body.toolUseResults[0].success, true);
  eq(body.toolUseResults[0].message, "已写入 hello.txt");
});

// ------------------------------------------------- 3 内部工具 relay 自答
await check("3 内部工具(task_complete)由 relay 自答，客户端只看到正文", async () => {
  reset([
    [answer({ delta: "收尾。" }), call("call_x", "task_complete", { summary: "done" })],
    [answer({ delta: "任务完成。", end: true })],
  ]);
  const r = await postSse("/v1/chat/completions", { model: "auto", stream: true, messages: [userMsg] });
  const text = r.events.filter((e) => e.data.choices?.[0]?.delta?.content).map((e) => e.data.choices[0].delta.content).join("");
  eq(text, "收尾。任务完成。", "两次 hop 的正文都应送达");
  const tc = r.events.find((e) => e.data.choices?.[0]?.delta?.tool_calls);
  assert(!tc, "内部工具不应泄漏给客户端");
  eq(r.events.find((e) => e.data.choices?.[0]?.finish_reason).data.choices[0].finish_reason, "stop");
  const hops = up.requests.filter((q) => q.url.endsWith("/v2/execute"));
  eq(hops.length, 2, "relay 应自己再跑一跳");
  eq(hops[1].body.toolUseResults[0].name, "task_complete");
  eq(hops[1].body.query, "");
});

// ------------------------------------------------------ 4 Anthropic 流式
await check("4 Anthropic 流式：thinking block 成型(开始/增量/结束) + text block + tool_use block", async () => {
  reset([[
    answer({ reasoningDelta: "思考中" }),
    answer({ delta: "写文件。" }),
    call("call_2", "Write", { file_path: "a.txt" }),
    frame("FUNCTION_CALL_END", { toolUse: [{ id: "call_2", name: "Write" }] }),
  ]]);
  const r = await postSse("/v1/messages", { model: "auto", stream: true, messages: [{ role: "user", content: "写 a.txt" }],
    tools: [{ name: "write_file", description: "写文件", input_schema: { type: "object", properties: { file_path: { type: "string" } } } }] });
  const t = r.events.map((e) => e.data);
  if (process.env.COMATE_TEST_DEBUG) console.log(JSON.stringify(t, null, 1));
  eq(t[0].type, "message_start");
  eq(t[1].type, "content_block_start");
  eq(t[1].content_block.type, "thinking", "思维链必须先开 thinking 块");
  eq(t[2].delta.type, "thinking_delta");
  const thinkStop = t.find((e) => e.type === "content_block_stop" && e.index === t[1].index);
  assert(thinkStop, "thinking 块必须闭合");
  const textStart = t.find((e) => e.type === "content_block_start" && e.content_block.type === "text");
  assert(textStart, "缺 text 块");
  assert(textStart.index > t[1].index, "text 块应在 thinking 之后另起索引");
  const toolStart = t.find((e) => e.type === "content_block_start" && e.content_block.type === "tool_use");
  eq(toolStart.content_block.name, "write_file", "工具名映射到客户端声明");
  const input = t.find((e) => e.delta?.type === "input_json_delta");
  eq(JSON.parse(input.delta.partial_json), { file_path: "a.txt" }, "input_json_delta 里是过滤后的参数");
  eq(t.find((e) => e.type === "message_delta").delta.stop_reason, "tool_use");
  eq(t[t.length - 1].type, "message_stop", "必须以 message_stop 收尾");
});

// ------------------------------------------------------- 5 非流式也带思维链
await check("5 非流式(execute-sync)：答案与思维链都进响应体", async () => {
  reset([]);
  up.syncHops = [[answer({ reasoningDelta: "想" }), answer({ delta: "答", end: true })]];
  const r = await postJson("/v1/chat/completions", { model: "auto", stream: false, messages: [userMsg] });
  const j = JSON.parse(r.text);
  eq(j.choices[0].message.content, "答");
  eq(j.choices[0].message.reasoning_content, "想");
});

// ------------------------------------------------------------ 6 降级
await check("6 上游不支持流式时降级 execute-sync，答案仍然完整", async () => {
  reset([]);
  up.streamRejected = true;
  up.syncHops = [[answer({ delta: LONG, end: true })]];
  const r = await postSse("/v1/chat/completions", { model: "auto", stream: true, messages: [userMsg] });
  const text = r.events.filter((e) => e.data.choices?.[0]?.delta?.content).map((e) => e.data.choices[0].delta.content).join("");
  eq(text, LONG, "降级后正文不能丢");
  assert(up.requests.some((q) => q.url.endsWith("/v2/execute-sync")), "应调用 execute-sync");
  eq(r.events.find((e) => e.data.choices?.[0]?.finish_reason).data.choices[0].finish_reason, "stop");
});

// ---------------------------------------------------------------- 汇总
for (const [name, ok, msg] of results) console.log(ok ? "PASS " : "FAIL ", name, ok ? "" : `— ${msg}`);
const pass = results.filter((r) => r[1]).length;
console.log(`\n==== ${pass}/${results.length} ====`);
upstream.close();
server.close();
process.exit(pass === results.length ? 0 : 1);
