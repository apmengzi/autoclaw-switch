// Comate relay 的 /v1/responses（Codex 接入）假上游集成测试：`node comate/test_responses.mjs`
//
// 不联网、不消耗额度：本地 HTTP 服务冒充 comate.baidu.com，验证
//   1 流式：created→推理→正文→工具→completed 的完整事件序与条目形状（write_file 名字映射）
//   2 工具续跑：Responses 形状的 function_call(_output) 历史 → 同 conv/task 续跑
//   3 非流式：chatCompletionToResponses 的完整响应体
//   4 压缩回合：compaction_trigger → 恰好一个 compaction 条目（Codex 硬要求）
//   5 上游失败：流已开 → response.failed 帧（不是 chat 形状的 error 帧）
//   6 custom(freeform) 工具降级与还原：apply_patch 走 {input:string} 通道
//   7 Codex 真身（只声明 exec_command）：上游的 Write/Bash 翻成 exec_command 命令行
//   8 客户端真没有的工具（TodoWrite）：relay 自己回说明，绝不把生名字丢给 Codex
//   9 交错历史：只把"还欠着"的结果回报上游，已交付过的不重复
//  10 客户端+relay 混合一批：内部工具的结果搭下一次续跑一起交回
process.env.APPDATA = (await import("node:fs")).mkdtempSync(
  (await import("node:path")).join((await import("node:os")).tmpdir(), "comate-responses-"));
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
  catch (e) { results.push([name, false, e.message + (process.env.COMATE_TEST_DEBUG ? "\n    " + String(e.stack).split("\n").slice(1, 5).join("\n    ") : "")]); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || "assert failed"); };
const eq = (a, b, msg) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg || "not equal"}: ${A} !== ${B}`);
};

// ------------------------------------------------------------- 假上游
const frame = (type, detail, extra = {}) => JSON.stringify({
  sessionId: "s1", content: { type, detail, text: JSON.stringify(detail), end: false, ...extra },
});
const answer = (d) => frame("ANSWER", d);
const call = (id, name, input) => frame("FUNCTION_CALL_START", { toolUse: [{ id, name, input }] });

const up = { plan: [], hop: 0, requests: [], syncHops: [], failMode: null };
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
  if (req.url.endsWith("/v2/execute-sync")) return json({ code: 200, frames: up.syncHops.shift() || [] });
  if (req.url.endsWith("/v2/execute")) {
    if (up.failMode === "quota") return json({ code: 200, message: "QUOTA_EXCEED", data: { code: "QUOTA_EXCEED" } }, 403);
    if (up.failMode === "midstream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${answer({ delta: "半截" })}\n\n`);
      await sleep(30);
      res.write(`data: ${frame("EXCEPTION", { message: "上游崩了", code: "UPSTREAM_EXCEPTION" })}\n\n`);
      res.end();
      return;
    }
    const frames = up.plan[up.hop++] || [];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(":heartbeat\n\n");
    for (const f of frames) { await sleep(30); res.write(`data: ${f}\n\n`); }
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

// 客户端侧：POST 一个 SSE 请求，解析 event:/data: 两种行
function postSse(pathname, body, headers = {}) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: PORT, path: pathname, method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "comate-local", "Content-Length": Buffer.byteLength(data), ...headers } }, (res) => {
      const frames = [];
      let buf = "";
      res.on("data", (c) => {
        buf += c.toString("utf8");
        const blocks = buf.split("\n\n");
        buf = blocks.pop() ?? "";
        for (const block of blocks) {
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const dl = /^data: (.+)$/m.exec(block)?.[1];
          if (dl === "[DONE]") { frames.push({ event: "DONE" }); continue; }
          if (!dl) continue;
          try { frames.push({ event: ev, at: Date.now() - t0, data: JSON.parse(dl) }); } catch {}
        }
      });
      res.on("end", () => resolve({ frames, status: res.statusCode }));
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

// Codex 真机请求的最小形状（tools 里 function + custom 两类，token 平铺）
const CODEX_TOOLS = [
  { type: "function", name: "write_file", description: "写文件",
    parameters: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path"] } },
  { type: "custom", name: "apply_patch", description: "Apply a patch",
    format: { type: "grammar", syntax: "lark", definition: "start: /.*/" } },
];
const codexBody = (extra = {}) => ({
  model: "auto", instructions: "You are Codex.", stream: true,
  tools: CODEX_TOOLS, tool_choice: "auto", parallel_tool_calls: false,
  reasoning: { summary: "auto" }, store: false, include: ["reasoning.encrypted_content"],
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "写一个 hello.txt" }] }],
  ...extra,
});
const reset = (plan) => { up.plan = plan; up.hop = 0; up.requests = []; up.failMode = null; };
const evOf = (r, t) => r.frames.filter((f) => f.event === t).map((f) => f.data);
const okFrames = (r) => r.frames.filter((f) => ["response.created", "response.in_progress", "response.completed", "response.incomplete", "response.failed"].includes(f.event));

const CALL_FRAMES = [
  answer({ reasoningDelta: "先想一下路径…" }),
  answer({ delta: "好的，我先创建文件……" }),
  call("call_1", "Write", { file_path: "hello.txt" }),
  frame("FUNCTION_CALL_PARAMS_APPEND", { toolUse: [{ id: "call_1", input: { content: "hi" } }] }),
  frame("FUNCTION_CALL_END", { toolUse: [{ id: "call_1", name: "Write" }] }),
];
const LONG = "这是一段足够长的回答。".repeat(8);
const FINAL_FRAMES = [answer({ delta: LONG.slice(0, 60) }), answer({ delta: LONG.slice(60), end: true })];

// ---------------------------------------------------------------- 1 真流式
await check("1 流式：created→推理→正文→工具→completed，事件序与条目形状正确", async () => {
  reset([CALL_FRAMES]);
  const r = await postSse("/v1/responses", codexBody());
  assert(r.status === 200, `status ${r.status}`);
  const types = r.frames.map((f) => f.event).filter((t) => t && t !== "DONE");
  // 生命周期：created/in_progress 在最前，completed 在最后
  eq(types.slice(0, 2), ["response.created", "response.in_progress"], "开头 created/in_progress");
  eq(types.at(-1), "response.completed", "结尾 completed");
  // 推理
  eq(evOf(r, "response.reasoning_summary_text.delta").map((d) => d.delta), ["先想一下路径…"], "推理增量");
  const rAdded = evOf(r, "response.output_item.added").find((d) => d.item.type === "reasoning");
  assert(rAdded, "缺 reasoning 条目");
  eq(rAdded.output_index, 0, "推理占 0 号 index");
  // 正文
  eq(evOf(r, "response.output_text.delta").map((d) => d.delta), ["好的，我先创建文件……"], "正文增量逐帧");
  // 工具：名字必须映射回客户端声明（write_file），参数是合并后的对象
  const fcAdded = evOf(r, "response.output_item.added").find((d) => d.item.type === "function_call");
  assert(fcAdded, "缺 function_call 条目");
  const fcDone = evOf(r, "response.output_item.done").find((d) => d.item.type === "function_call");
  eq(fcDone.item.name, "write_file", "工具名映射");
  eq(fcDone.item.call_id, "call_1", "call_id 透传");
  eq(JSON.parse(fcDone.item.arguments), { file_path: "hello.txt", content: "hi" }, "参数合并");
  eq(evOf(r, "response.function_call_arguments.done")[0].arguments, JSON.stringify({ file_path: "hello.txt", content: "hi" }), "arguments.done 与条目一致");
  // completed 响应体
  const final = evOf(r, "response.completed")[0].response;
  eq(final.status, "completed", "completed 状态");
  eq(final.output.map((o) => o.type), ["reasoning", "message", "function_call"], "output 三类条目");
  eq(final.id, evOf(r, "response.created")[0].response.id, "响应 id 前后一致");
  // 帧序：DONE 收尾
  eq(r.frames.at(-1).event, "DONE", "[DONE] 收尾");
  // 上游侧：跑的是同一条 turn 流水线（modelKey 必带，真机踩过）
  const exec = up.requests.filter((q) => q.url.endsWith("/v2/execute")).pop();
  eq(exec.body.modelKey, "auto", "modelKey 必须带上");
  assert(up.requests.some((q) => q.url.endsWith("/v2/conversation")), "新会话只创建一次");
});

// ------------------------------------------------------- 2 工具续跑
await check("2 工具续跑：function_call(_output) 历史 → 同 conv/task、query 空、isFirstQuery=false", async () => {
  reset([FINAL_FRAMES]);
  const r = await postSse("/v1/responses", codexBody({ input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "写一个 hello.txt" }] },
    { type: "reasoning", summary: [{ type: "summary_text", text: "先想一下路径…" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "好的，我先创建文件……" }] },
    { type: "function_call", name: "write_file", arguments: "{\"file_path\":\"hello.txt\"}", call_id: "call_1" },
    { type: "function_call_output", call_id: "call_1", output: "已写入 hello.txt" },
  ] }));
  const text = evOf(r, "response.output_text.delta").map((d) => d.delta).join("");
  eq(text, LONG, "续跑答案完整");
  const body = up.requests.filter((q) => q.url.endsWith("/v2/execute")).pop().body;
  eq(body.conversationId, "conv-1", "回到同一 conversation");
  eq(body.taskId, "task-1", "回到同一 task");
  eq(body.query, "", "续跑 query 为空");
  eq(body.isFirstQuery, false);
  eq(body.toolUseResults.length, 1, "一份工具结果");
  eq(body.toolUseResults[0].name, "write_file", "回报用 canonical 名");
  eq(body.toolUseResults[0].message, "已写入 hello.txt");
  assert(!up.requests.some((q) => q.url.endsWith("/v2/conversation")), "续跑不应新建会话");
});

// ---------------------------------------------------------------- 3 非流式
await check("3 非流式：一次性响应体（推理+正文+工具+usage）", async () => {
  reset([]);
  up.syncHops = [[
    answer({ reasoningDelta: "想" }),
    answer({ delta: "答", end: true }),
    call("call_2", "Write", { file_path: "a.txt" }),
  ]];
  const r = await postJson("/v1/responses", codexBody({ stream: false }));
  assert(r.status === 200, `status ${r.status}`);
  const j = JSON.parse(r.text);
  eq(j.object, "response", "object=response");
  eq(j.output.map((o) => o.type), ["reasoning", "message", "function_call"], "三类条目");
  eq(j.output[1].content[0].text, "答", "正文");
  eq(j.output[0].summary[0].text, "想", "推理");
  eq(j.output[2].name, "write_file", "工具名映射");
  assert(j.usage, "usage 必须存在");
});

// ---------------------------------------------------------------- 4 压缩回合
await check("4 压缩回合：compaction_trigger → 恰好一个 compaction 条目", async () => {
  reset([[answer({ delta: "handoff summary body", end: true })]]);   // 走流式路径（turnEvents）
  const r = await postSse("/v1/responses", codexBody({
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }, { type: "compaction_trigger" }],
  }));
  const types = r.frames.map((f) => f.event).filter((t) => t && t !== "DONE");
  eq(types, ["response.created", "response.output_item.done", "response.completed"], "压缩帧序：无 added、恰一个 done");
  const item = evOf(r, "response.output_item.done")[0].item;
  eq(item.type, "compaction", "条目类型");
  assert(item.encrypted_content.startsWith("aswitch-compaction-v1:"), "自家信封前缀");
  const completed = evOf(r, "response.completed")[0].response;
  eq(completed.output.length, 1, "output 恰一条");
  // 压缩请求：查询里是 Codex 的压缩提示词，且不再声明工具（只当摘要模型用）
  const exec = up.requests.filter((q) => q.url.endsWith("/v2/execute")).pop();
  assert(exec.body.query.includes("CONTEXT CHECKPOINT COMPACTION"), "压缩提示词进入查询");
});

// ---------------------------------------------------------------- 5 上游失败
await check("5 流中途上游异常：response.failed 帧（Codex 能读的形状）", async () => {
  reset([]);
  up.failMode = "midstream";
  const r = await postSse("/v1/responses", codexBody());
  const failed = evOf(r, "response.failed");
  eq(failed.length, 1, "恰一帧 response.failed");
  assert(failed[0].response.error.message.includes("comate-relay"), "错误信息带前缀");
  eq(failed[0].response.status, "failed", "状态 failed");
  eq(r.frames.at(-1).event, "DONE", "[DONE] 收尾");
  assert(!r.frames.some((f) => f.event === "response.completed"), "不应再发 completed");
});

// ------------------------------------------------------- 6 custom 工具
await check("6 custom(freeform) 工具：降级成 {input} 后回传 custom_tool_call", async () => {
  reset([[
    call("call_3", "apply_patch", { input: "*** Begin Patch\n+hi\n" }),
    frame("FUNCTION_CALL_END", { toolUse: [{ id: "call_3", name: "apply_patch" }] }),
  ]]);
  const r = await postSse("/v1/responses", codexBody());
  const done = evOf(r, "response.output_item.done").find((d) => d.item.type === "custom_tool_call");
  assert(done, "缺 custom_tool_call 条目");
  eq(done.item.name, "apply_patch", "名字");
  eq(done.item.input, "*** Begin Patch\n+hi\n", "input 取原始串");
  assert(done.item.id.startsWith("ctc_"), "id 形状 ctc_");
  eq(evOf(r, "response.custom_tool_call_input.done")[0].input, "*** Begin Patch\n+hi\n", "input.done 帧");
});

// ------------------------------------------- 7 Codex 真身（只有 exec_command）
// Codex 0.160 抓包：tools 里只有一个执行工具 exec_command（必填 cmd），文件类工具
// 一个都没有。上游 agent 说的却是 IDE 词汇，所以必须翻译，否则 Codex 直接
// `unsupported call: Bash` 拒收（真机就是这么炸的）。
const CODEX_SHELL_TOOLS = [
  { type: "function", name: "exec_command", description: "Runs a command in a PTY",
    parameters: { type: "object", properties: {
      cmd: { type: "string" }, justification: { type: "string" }, workdir: { type: "string" }, yield_time_ms: { type: "number" },
    }, required: ["cmd"] } },
  { type: "function", name: "view_image", description: "View a local image",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
];
const CONTENT = "第一行 'quoted'\n第二行 emoji 🙂 $env:X";
const DUAL_FRAMES = [
  call("call_w", "Write", { file_path: "sub dir/hello.txt", content: CONTENT }),
  frame("FUNCTION_CALL_END", { toolUse: [{ id: "call_w", name: "Write" }] }),
  call("call_b", "Bash", { command: "echo aswitch-e2e" }),
  frame("FUNCTION_CALL_END", { toolUse: [{ id: "call_b", name: "Bash" }] }),
];

await check("7 Codex 工具词汇翻译：Write/Bash → exec_command{cmd}，内容 base64 逐字节还原", async () => {
  reset([DUAL_FRAMES]);
  const r = await postSse("/v1/responses", codexBody({ tools: CODEX_SHELL_TOOLS }));
  const calls = evOf(r, "response.output_item.done").filter((d) => d.item.type === "function_call").map((d) => d.item);
  eq(calls.length, 2, "两个调用都要出现");
  eq(calls.map((c) => c.name), ["exec_command", "exec_command"], "名字必须是客户端声明的 exec_command");
  eq(calls.map((c) => c.call_id), ["call_w", "call_b"], "call_id 保持上游的（续跑要靠它）");
  const w = JSON.parse(calls[0].arguments);
  assert(w.cmd.includes("'sub dir/hello.txt'"), "路径进命令");
  const b64 = /FromBase64String\('([A-Za-z0-9+/=]*)'\)/.exec(w.cmd)?.[1];
  eq(Buffer.from(b64, "base64").toString("utf8"), CONTENT, "写文件内容逐字节一致");
  assert(!w.cmd.includes("emoji"), "原文不出现在命令行里");
  eq(Object.keys(w), ["cmd"], "参数只有 cmd（带 justification 会被 Codex 拒收）");
  eq(JSON.parse(calls[1].arguments).cmd, "echo aswitch-e2e", "命令原样透传");
  // 客户端回报后，续跑要拿上游自己的名字（write_file/run_command），不是 exec_command
  reset([FINAL_FRAMES]);
  const r2 = await postSse("/v1/responses", codexBody({ tools: CODEX_SHELL_TOOLS, input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "写文件并执行" }] },
    { type: "function_call", name: "exec_command", arguments: calls[0].arguments, call_id: "call_w" },
    { type: "function_call_output", call_id: "call_w", output: "已写入" },
    { type: "function_call", name: "exec_command", arguments: calls[1].arguments, call_id: "call_b" },
    { type: "function_call_output", call_id: "call_b", output: "aswitch-e2e" },
  ] }));
  eq(evOf(r2, "response.output_text.delta").map((d) => d.delta).join(""), LONG, "续跑答案完整");
  const body = up.requests.filter((q) => q.url.endsWith("/v2/execute")).pop().body;
  eq(body.toolUseResults.map((t) => t.name), ["write_file", "run_command"], "回报用上游词汇");
  eq(body.toolUseResults.map((t) => t.message), ["已写入", "aswitch-e2e"], "结果原文带给上游");
  eq(body.conversationId, "conv-1", "回到同一 conversation");
});

await check("8 客户端没有的工具（TodoWrite）：relay 自答说明，不发流浪到 Codex", async () => {
  reset([
    [call("call_t", "TodoWrite", { todos: [{ content: "第一步" }] })],
    [answer({ delta: "好，我改用 shell 做。", end: true })],
  ]);
  const r = await postSse("/v1/responses", codexBody({ tools: CODEX_SHELL_TOOLS }));
  const bad = evOf(r, "response.output_item.done").filter((d) => (d.item.type || "").includes("call"));
  eq(bad.length, 0, "不应有任何工具调用发给客户端");
  eq(evOf(r, "response.output_text.delta").map((d) => d.delta).join(""), "好，我改用 shell 做。", "正文照常");
  const hops = up.requests.filter((q) => q.url.endsWith("/v2/execute"));
  eq(hops.length, 2, "relay 自己多跑一跳回报");
  const res = hops[1].body.toolUseResults[0];
  eq(res.name, "todo_write", "回报用 canonical 名");
  eq(res.success, false, "不可用就是失败态");
  assert(res.message.includes("TodoWrite") && res.message.includes("exec_command"), "说明里点名工具与替代品");
  eq(hops[1].body.query, "", "续跑 query 为空");
});

// ------------------------------------------------- 9 交错历史的续跑判定
await check("9 交错历史：已交付过的旧结果不再重复上报，只报当前这一批", async () => {
  // 第一跳：交给客户端一个调用（它的历史从这一刻起累积）
  reset([[call("c1", "Bash", { command: "echo one" })]]);
  const r1 = await postSse("/v1/responses", codexBody({ tools: CODEX_SHELL_TOOLS }));
  const a1 = evOf(r1, "response.output_item.done").find((d) => d.item.type === "function_call").item;
  // 第二跳：客户端回报 c1（relay 交付并注销），这一跳上游又给出新调用 c2
  reset([[call("c2", "Read", { file_path: "a.txt" })]]);
  const r2 = await postSse("/v1/responses", codexBody({ tools: CODEX_SHELL_TOOLS, input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "先执行再读" }] },
    { type: "function_call", name: a1.name, arguments: a1.arguments, call_id: "c1" },
    { type: "function_call_output", call_id: "c1", output: "one" },
  ] }));
  const b2 = up.requests.filter((q) => q.url.endsWith("/v2/execute")).pop().body;
  eq(b2.toolUseResults.map((t) => t.name), ["run_command"], "这一跳只报 c1");
  const a2 = evOf(r2, "response.output_item.done").find((d) => d.item.type === "function_call").item;
  // 第三跳：历史里 c1、c2 都在（成对交错），c1 已交付过 → 只能报 c2
  reset([FINAL_FRAMES]);
  await postSse("/v1/responses", codexBody({ tools: CODEX_SHELL_TOOLS, input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "先执行再读" }] },
    { type: "function_call", name: a1.name, arguments: a1.arguments, call_id: "c1" },
    { type: "function_call_output", call_id: "c1", output: "one" },
    { type: "function_call", name: a2.name, arguments: a2.arguments, call_id: "c2" },
    { type: "function_call_output", call_id: "c2", output: "file body" },
  ] }));
  const b3 = up.requests.filter((q) => q.url.endsWith("/v2/execute")).pop().body;
  eq(b3.toolUseResults.map((t) => t.name), ["read_file"], "旧结果不能重复上报（真机日志里曾出现空名字的重复项）");
  eq(b3.toolUseResults[0].message, "file body", "报的是当前这批的结果");
  eq(b3.conversationId, "conv-1", "仍然回到同一会话续跑");
});

await check("10 客户端+relay 混合一批：续跑时内部工具的结果一并交回上游", async () => {
  reset([[
    call("c1", "Bash", { command: "echo hi" }),
    frame("FUNCTION_CALL_END", { toolUse: [{ id: "c1", name: "Bash" }] }),
    call("i1", "task_complete", { summary: "done" }),
    frame("FUNCTION_CALL_END", { toolUse: [{ id: "i1", name: "task_complete" }] }),
  ]]);
  const r = await postSse("/v1/responses", codexBody({ tools: CODEX_SHELL_TOOLS }));
  const items = evOf(r, "response.output_item.done").filter((d) => d.item.type === "function_call").map((d) => d.item);
  eq(items.map((i) => i.call_id), ["c1"], "客户端只该看到自己的那个调用");
  reset([FINAL_FRAMES]);
  await postSse("/v1/responses", codexBody({ tools: CODEX_SHELL_TOOLS, input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
    { type: "function_call", name: items[0].name, arguments: items[0].arguments, call_id: "c1" },
    { type: "function_call_output", call_id: "c1", output: "hi" },
  ] }));
  const body = up.requests.filter((q) => q.url.endsWith("/v2/execute")).pop().body;
  eq(body.toolUseResults.map((t) => t.name).sort(), ["run_command", "task_complete"], "内部结果搭这一跳一起交回");
  eq(body.toolUseResults.find((t) => t.name === "task_complete").message, "ok");
  eq(body.toolUseResults.find((t) => t.name === "run_command").message, "hi");
});

// ---------------------------------------------------------------- 汇总
for (const [name, ok, msg] of results) console.log(ok ? "PASS " : "FAIL ", name, ok ? "" : `— ${msg}`);const pass = results.filter((r) => r[1]).length;
console.log(`\n==== ${pass}/${results.length} ====`);
upstream.close();
server.close();
process.exit(pass === results.length ? 0 : 1);
