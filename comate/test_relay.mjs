// Comate relay 的离线回归测试：`node comate/test_relay.mjs`
//
// 全部不碰网络、不读凭证：用 COMATE_RELAY_NO_LISTEN=1 只加载 relay 的纯函数
// 与数据结构，逐条钉住 2026-10-06 修复“任务跑不完”时定下的协议契约——
// 帧→工具调用的拼装、参数逐段累加、续跑路由表、两种协议的消息归一化、
// 以及回给调用方的工具名/schema 过滤。真机链路见 comate/e2e_tool_loop.mjs
// （消耗额度，默认不跑）。
process.env.COMATE_RELAY_NO_LISTEN = "1";
const {
  TOOL_ALIASES, INTERNAL_TOOL_NAMES, canonicalToolName, mergeToolParams,
  toolRouting, rememberToolRouting, lookupToolRouting, forgetToolRouting,
  reduceFrames, extractPending, flattenQuery, normalizeOpenAIMessages, normalizeAnthropicMessages,
  clientToolIndex, toolNameForClient, clientToolCalls, openaiToolCalls,
} = await import(new URL("./relay.mjs", import.meta.url));

const results = [];
const check = (name, fn) => {
  try { fn(); results.push([name, true]); }
  catch (e) { results.push([name, false, e.message]); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || "assert failed"); };
const eq = (a, b, msg) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg || "not equal"}: ${A} !== ${B}`);
};

// 上游帧：content.text 是字符串化的 JSON，content.detail 是同一对象。
const frame = (type, detail, extra = {}) => JSON.stringify({
  sessionId: "s1", content: { type, detail, text: JSON.stringify(detail), end: false, ...extra },
});

// ---------------------------------------------------------------- A 参数累加
check("A1 mergeToolParams 字符串片段逐段拼成同一 key", () => {
  const p = {};
  mergeToolParams(p, { content: "hi" });
  mergeToolParams(p, { content: "" });
  mergeToolParams(p, { file_path: "hello" });
  mergeToolParams(p, { file_path: ".txt" });
  eq(p, { content: "hi", file_path: "hello.txt" });
});
check("A2 非字符串整体替换，对象浅合并，新键直接写入", () => {
  const p = { n: 1, obj: { a: 1 }, keep: "x" };
  mergeToolParams(p, { n: 2, obj: { b: 2 }, extra: true });
  eq(p, { n: 2, obj: { a: 1, b: 2 }, keep: "x", extra: true });
});
check("A3 空 patch 不改动已有参数", () => {
  const p = { a: "1" };
  mergeToolParams(p, {});
  mergeToolParams(p, null);
  eq(p, { a: "1" });
});

// ------------------------------------------------------------ B 工具名规范
check("B1 帧用 Claude 词汇，回报用 canonical 名", () => {
  eq(canonicalToolName("Bash"), "run_command");
  eq(canonicalToolName("Edit"), "edit_file");
  eq(canonicalToolName("Glob"), "glob_path");
});
check("B2 已是 canonical 的名字与未知名字原样返回", () => {
  eq(canonicalToolName("write_file"), "write_file");
  eq(canonicalToolName("my_custom_tool"), "my_custom_tool");
  eq(canonicalToolName(""), "");
});
check("B3 控制类工具在应答名单里（IDE 内核不把它们交给模型方）", () => {
  for (const n of ["compress_message", "task_complete", "memory_extract"]) assert(INTERNAL_TOOL_NAMES.has(n), n);
  assert(!TOOL_ALIASES.compress_message, "compress_message 不该出现在别名表里");
});

// -------------------------------------------------------------- C 帧 → 工具调用
check("C1 ANSWER 帧拼文本与思考，end 标记生效", () => {
  const o = reduceFrames([
    frame("ANSWER", { delta: "你好", reasoningDelta: "想" }),
    frame("ANSWER", { delta: "，世界", reasoningDelta: "一下" }),
    frame("ANSWER", { delta: "", end: true }),
  ]);
  eq(o.text, "你好，世界");
  eq(o.reasoning, "想一下");
  assert(o.end === true, "end 未生效");
});
check("C2 多帧参数按 key 累加，拼出完整调用", () => {
  const o = reduceFrames([
    frame("FUNCTION_CALL_START", { toolUse: [{ id: "call_1", name: "Write", input: {} }] }),
    frame("FUNCTION_CALL_PARAMS_APPEND", { toolUse: [{ id: "call_1", input: { file_path: "D:\\ws\\he" } }] }),
    frame("FUNCTION_CALL_PARAMS_APPEND", { toolUse: [{ id: "call_1", input: { content: "hi" } }] }),
    frame("FUNCTION_CALL_PARAMS_APPEND", { toolUse: [{ id: "call_1", input: { file_path: "llo.txt" } }] }),
    frame("FUNCTION_CALL_END", { toolUse: [{ id: "call_1", input: {} }] }),
  ]);
  eq(o.toolCalls, [{ id: "call_1", name: "Write", params: { file_path: "D:\\ws\\hello.txt", content: "hi" } }]);
});
check("C3 同轮多个工具各自成条且顺序稳定", () => {
  const o = reduceFrames([
    frame("FUNCTION_CALL_START", { toolUse: [{ id: "a", name: "Read", input: { file_path: "x" } }] }),
    frame("FUNCTION_CALL_START", { toolUse: [{ id: "b", name: "Bash", input: { command: "ls" } }] }),
    frame("FUNCTION_CALL_END", { toolUse: [{ id: "a", input: {} }, { id: "b", input: {} }] }),
  ]);
  eq(o.toolCalls.map((t) => t.id), ["a", "b"]);
  eq(o.toolCalls.map((t) => t.name), ["Read", "Bash"]);
});
check("C4 TOKEN_USAGE 两种键名都能读，缺字段补 0", () => {
  const a = reduceFrames([frame("TOKEN_USAGE", { usage: { inputTokens: 12, outputTokens: 7, cachedInputTokens: 3 } })]);
  eq([a.usage.input_tokens, a.usage.output_tokens], [12, 7]);
  const b = reduceFrames([frame("TOKEN_USAGE", { usage: { prompt_tokens: 5 } })]);
  eq([b.usage.input_tokens, b.usage.output_tokens], [5, 0]);
});
check("C5 rollbackMessageId 从任意帧捕获", () => {
  const o = reduceFrames([frame("ANSWER", { delta: "x", rollbackMessageId: "m9" })]);
  eq(o.rollbackMessageId, "m9");
});
check("C6 ANSWER 帧里挂的 toolUse 也认（旧形状）", () => {
  const o = reduceFrames([frame("ANSWER", { delta: "", toolUse: [{ id: "t1", name: "Bash", input: { command: "pwd" } }] })]);
  eq(o.toolCalls, [{ id: "t1", name: "Bash", params: { command: "pwd" } }]);
});
check("C7 缺名/缺 id 的工具帧被丢弃，坏帧不致命", () => {
  const o = reduceFrames([
    "not json at all",
    frame("FUNCTION_CALL_START", { toolUse: [{ id: "x", input: { a: "1" } }] }),
    frame("FUNCTION_CALL_PARAMS_APPEND", { toolUse: [{ name: "Read", input: { file_path: "y" } }] }),
    frame("FUNCTION_CALL_START", { toolUse: [{ id: "z", name: "Read", input: { file_path: "y" } }] }),
  ]);
  eq(o.toolCalls, [{ id: "z", name: "Read", params: { file_path: "y" } }]);
});

// -------------------------------------------------------------- D 续跑判定
check("D1 尾部连续 tool 结果 → 判定为续跑并带回上一轮调用", () => {
  const msgs = [
    { role: "user", content: "建文件" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "Write", arguments: "{}" }] },
    { role: "tool", content: "", toolResult: { id: "c1", name: "Write", text: "ok" } },
  ];
  const p = extractPending(msgs);
  eq(p.results.map((r) => r.id), ["c1"]);
  eq(p.calls.map((c) => c.name), ["Write"]);
});
check("D2 工具结果后面还有普通消息 → 不是续跑（走全新会话）", () => {
  eq(extractPending([
    { role: "tool", content: "", toolResult: { id: "c1", name: "Write", text: "ok" } },
    { role: "assistant", content: "接着聊" },
  ]), null);
});
check("D3 没有工具结果 → null", () => {
  eq(extractPending([{ role: "user", content: "hi" }]), null);
  eq(extractPending([]), null);
});

// ------------------------------------------------------------ E 消息归一化
check("E1 OpenAI tool 消息 → toolResult 三件套", () => {
  const out = normalizeOpenAIMessages([
    { role: "user", content: "hi" },
    { role: "tool", tool_call_id: "c1", name: "Write", content: "done" },
  ]);
  eq(out[1], { role: "tool", content: "", toolResult: { id: "c1", name: "Write", text: "done" } });
});
check("E2 tool_calls 的 arguments 字符串/对象两形状都收，空消息被跳过", () => {
  const out = normalizeOpenAIMessages([
    { role: "assistant", content: null, tool_calls: [
      { id: "a", function: { name: "Write", arguments: "{\"file_path\":\"x\"}" } },
      { id: "b", function: { name: "Read", arguments: { file_path: "y" } } },
    ] },
    { role: "assistant", content: "   " },
  ]);
  eq(out.length, 1);
  eq(out[0].toolCalls.map((c) => c.arguments), ["{\"file_path\":\"x\"}", "{\"file_path\":\"y\"}"]);
});
check("E3 Anthropic 的 system/tool_use/tool_result（含 is_error）", () => {
  const out = normalizeAnthropicMessages({
    system: [{ type: "text", text: "你是助手" }],
    messages: [
      { role: "user", content: "建文件" },
      { role: "assistant", content: [{ type: "text", text: "好" }, { type: "tool_use", id: "u1", name: "Write", input: { file_path: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: [{ type: "text", text: "失败" }], is_error: true }] },
    ],
  });
  eq(out[0], { role: "system", content: "你是助手" });
  eq(out[1].content, "建文件");
  eq(out[2].toolCalls[0], { id: "u1", name: "Write", arguments: "{\"file_path\":\"x\"}", params: { file_path: "x" } });
  eq(out[3].toolResult, { id: "u1", name: "", text: "失败", isError: true });
});
check("E4 Anthropic 字符串 content 与纯文本 system 分支", () => {
  const out = normalizeAnthropicMessages({ system: "sys", messages: [{ role: "assistant", content: "在" }] });
  eq(out, [{ role: "system", content: "sys" }, { role: "assistant", content: "在" }]);
});

// ------------------------------------------------------------ F 历史铺平
check("F1 工具轮在铺平文本里有可读标注", () => {
  const q = flattenQuery([
    { role: "system", content: "规矩" },
    { role: "user", content: "建文件" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "Write", arguments: "{\"file_path\":\"x\"}" }] },
    { role: "tool", content: "", toolResult: { id: "c1", name: "Write", text: "ok" } },
  ]);
  assert(q.includes("[System instructions]\n规矩"), "system 标注丢了");
  assert(q.includes("[Assistant tool call]\nWrite("), "工具调用标注丢了");
  assert(q.includes("[Tool result Write]\nok"), "工具结果标注丢了");
});
check("F2 空历史回退成 hello（上游不接受空 query）", () => {
  eq(flattenQuery([]), "hello");
  eq(flattenQuery([{ role: "assistant", content: "  " }]), "hello");
});

// --------------------------------------------- G 回给调用方的名字与参数过滤
const OAI_TOOLS = [
  { type: "function", function: { name: "Write", parameters: { properties: { file_path: {}, content: {} } } } },
  { type: "function", function: { name: "Bash", parameters: { properties: { command: {} } } } },
];
const A_TOOLS = [{ name: "run_command", input_schema: { properties: { command: {} } } }];

check("G1/G2 索引形状：OpenAI 取 function.parameters，Anthropic 取 input_schema", () => {
  eq([...clientToolIndex(OAI_TOOLS, "openai").keys()], ["Write", "Bash"]);
  eq([...clientToolIndex(A_TOOLS, "anthropic").keys()], ["run_command"]);
  assert(clientToolIndex(OAI_TOOLS, "openai").get("Write").has("file_path"), "属性集没取到");
});
check("G3 调用方声明了同名工具 → 用调用方的拼写", () => {
  eq(toolNameForClient("Write", clientToolIndex(OAI_TOOLS, "openai")), "Write");
});
check("G4 调用方只认 canonical 名 → 上游 Bash 映射成 run_command", () => {
  eq(toolNameForClient("Bash", clientToolIndex(A_TOOLS, "anthropic")), "run_command");
});
check("G5 两边都对不上 → 原样透传（宁可多一个未知工具也不吞调用）", () => {
  eq(toolNameForClient("Mystery", clientToolIndex(OAI_TOOLS, "openai")), "Mystery");
  eq(toolNameForClient("Bash", new Map()), "Bash");
});
check("G6 schema 之外的参数被剔除（上游会塞 prefix_rule 之类）", () => {
  const calls = clientToolCalls({ toolCalls: [{ id: "c1", name: "Bash", params: { command: "ls", prefix_rule: [], description: "x" } }] },
    clientToolIndex(OAI_TOOLS, "openai"));
  eq(calls, [{ id: "c1", name: "Bash", params: { command: "ls" } }]);
});
check("G7 没声明 schema 属性时不做过滤，避免把参数清空", () => {
  const idx = clientToolIndex([{ type: "function", function: { name: "Write" } }], "openai");
  const calls = clientToolCalls({ toolCalls: [{ id: "c1", name: "Write", params: { a: 1, b: 2 } }] }, idx);
  eq(calls[0].params, { a: 1, b: 2 });
});
check("G8 openaiToolCalls 形状：index/type/function.arguments 为 JSON 串", () => {
  const o = openaiToolCalls({ toolCalls: [{ id: "c1", name: "Bash", params: { command: "ls" } }] }, clientToolIndex(OAI_TOOLS, "openai"));
  eq(o, [{ index: 0, id: "c1", type: "function", function: { name: "Bash", arguments: "{\"command\":\"ls\"}" } }]);
});

// ------------------------------------------------------------ H 续跑路由表
check("H1 remember → lookup 命中且带 conversation/task", () => {
  toolRouting.clear();
  rememberToolRouting([{ id: "c1", name: "run_command", params: { command: "ls" } }], "conv-1", "task-1");
  const e = lookupToolRouting(["nope", "c1"]);
  assert(e, "未命中");
  eq([e.conversationId, e.taskId, e.name], ["conv-1", "task-1", "run_command"]);
});
check("H2 forget 之后不再命中（结果只交付一次）", () => {
  forgetToolRouting(["c1"]);
  eq(lookupToolRouting(["c1"]), null);
});
check("H3 过期条目在下次写入时被清理", () => {
  toolRouting.clear();
  rememberToolRouting([{ id: "old" }], "conv-old", "task-old");
  toolRouting.get("old").at = Date.now() - 31 * 60 * 1000;
  rememberToolRouting([{ id: "new" }], "conv-new", "task-new");
  eq(lookupToolRouting(["old"]), null);
  assert(lookupToolRouting(["new"]), "新条目不该被误删");
});
check("H4 路由表有容量上限，不会无限增长", () => {
  toolRouting.clear();
  for (let round = 0; round < 400; round += 50)
    rememberToolRouting(Array.from({ length: 50 }, (_, i) => ({ id: `bulk-${round + i}` })), "c", "t");
  assert(toolRouting.size <= 256, `size=${toolRouting.size} 超过上限`);
  toolRouting.clear();
});
check("H5 内部工具的结果随下一次续跑一并交付", () => {
  toolRouting.clear();
  rememberToolRouting([{ id: "i1", internal: true, internalResult: { id: "i1", name: "task_complete", success: true, message: "ok" } }], "c", "t");
  const e = lookupToolRouting(["i1"]);
  eq(e.internalResult.name, "task_complete");
  assert(e.internal === true, "internal 标记丢了");
  toolRouting.clear();
});

const pass = results.filter((r) => r[1]).length;
for (const [name, ok, msg] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  <-- " + msg}`);
console.log(`\n==== ${pass}/${results.length} ====`);
process.exit(pass === results.length ? 0 : 1);
