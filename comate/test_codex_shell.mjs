// comate/codex_shell.mjs 的纯函数单测：`node comate/test_codex_shell.mjs`
//
// 不起服务、不联网。重点是两条：命令内容必须**逐字节**还原（base64 的意义就在这，
// 内容里混引号/换行/中文/emoji 都不能崩），以及没有 shell 可用时绝不硬翻。
const {
  findShellTool, canSynthesize, synthesizeShellCall, unavailableMessage,
} = await import("./codex_shell.mjs");

const results = [];
const check = (name, fn) => {
  try { fn(); results.push([name, true]); }
  catch (e) { results.push([name, false, e.message]); }
};
const assert = (c, m) => { if (!c) throw new Error(m || "assert failed"); };
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m || "not equal"}: ${A} !== ${B}`);
};

// Codex 0.160 真机抓包里的形状：exec_command 必填 cmd
const CODEX = new Map([
  ["exec_command", new Set(["cmd", "justification", "workdir", "yield_time_ms", "shell"])],
  ["write_stdin", new Set(["session_id", "chars"])],
  ["view_image", new Set(["path"])],
]);
const ZCODE = new Map([
  ["run_command", new Set(["command"])],
  ["write_file", new Set(["file_path", "content"])],
]);
const shellOf = (c) => ({ id: "c1", name: "x", params: {}, ...c });
const decode = (b64) => Buffer.from(b64, "base64").toString("utf8");
const b64In = (cmd) => /FromBase64String\('([A-Za-z0-9+/=]*)'\)/.exec(cmd)?.[1];

// ------------------------------------------------------------- findShellTool
check("findShellTool：Codex 的工具表 → exec_command + cmd", () => {
  eq(findShellTool(CODEX), { name: "exec_command", argKey: "cmd" });
});
check("findShellTool：ZCode 那套（run_command）也能认出来", () => {
  eq(findShellTool(ZCODE), { name: "run_command", argKey: "command" });
});
check("findShellTool：没有可执行工具时返回 null", () => {
  eq(findShellTool(new Map([["view_image", new Set(["path"])]])), null);
  eq(findShellTool(new Map()), null);
  eq(findShellTool(undefined), null);
});
check("findShellTool：custom(local_shell) 形态参数名取 input", () => {
  eq(findShellTool(new Map([["local_shell", null]])), { name: "local_shell", argKey: "command" });
  eq(findShellTool(new Map([["local_shell", new Set(["input"])]])), { name: "local_shell", argKey: "input" });
});
check("findShellTool：exec_command 声明里没有 cmd 就不敢用（宁可不翻）", () => {
  eq(findShellTool(new Map([["exec_command", new Set(["workdir"])]])), null);
});

// -------------------------------------------------------- write_file（重点）
const NASTY = "行1：单引号 ' 与双引号 \"\n行2：$env:PATH 反引号 ` 与中文\n行3：emoji 🙂 结尾无换行";

check("write_file(win)：内容是 base64，能逐字节还原", () => {
  const out = synthesizeShellCall(
    { id: "call_1", name: "Write", canon: "write_file", params: { file_path: "D:\\a b\\hello.txt", content: NASTY } },
    findShellTool(CODEX), "win32");
  assert(out, "应当能翻译");
  eq(out.name, "exec_command", "翻成 exec_command");
  eq(out.id, "call_1", "call_id 透传");
  assert(out.params.cmd.includes("'D:\\a b\\hello.txt'"), "路径单引号包裹");
  eq(decode(b64In(out.params.cmd)), NASTY, "内容逐字节还原");
  assert(!out.params.cmd.includes("' 与双引号"), "原文不能直接进命令行");
  eq(Object.keys(out.params), ["cmd"], "只给 cmd：justification 会触发 Codex 的越权校验，不能带");
});
check("write_file(posix)：base64 -d 落盘，目录先建", () => {
  const out = synthesizeShellCall(
    { id: "c", name: "Write", canon: "write_file", params: { path: "/tmp/it's/x.txt", content: "hi\nthere" } },
    findShellTool(CODEX), "linux");
  assert(out.params.cmd.startsWith('mkdir -p "$(dirname'), "先建目录");
  assert(out.params.cmd.includes("'\\''"), "路径里的单引号按 POSIX 规则转义");
  eq(decode(/printf %s '([A-Za-z0-9+/=]*)'/.exec(out.params.cmd)[1]), "hi\nthere");
});
check("write_file：缺内容/缺路径都不硬翻", () => {
  const shell = findShellTool(CODEX);
  eq(synthesizeShellCall({ id: "c", name: "Write", canon: "write_file", params: { file_path: "a.txt" } }, shell, "win32"), null);
  eq(synthesizeShellCall({ id: "c", name: "Write", canon: "write_file", params: { content: "x" } }, shell, "win32"), null);
  eq(synthesizeShellCall({ id: "c", name: "Write", canon: "write_file", params: { file_path: "a.txt", content: "" } }, shell, "win32"), null);
});

// ------------------------------------------------------------- 其余构造器
check("run_command：命令原样透传（不再包一层引号）", () => {
  const out = synthesizeShellCall({ id: "c", name: "Bash", canon: "run_command", params: { command: "npm test && echo 'ok'" } }, findShellTool(CODEX), "win32");
  eq(out.params.cmd, "npm test && echo 'ok'");
});
check("read_file / list_dir / delete_file：平台各一套", () => {
  const shell = findShellTool(CODEX);
  const read = synthesizeShellCall({ id: "c", name: "Read", canon: "read_file", params: { file_path: "C:\\x y\\a.txt" } }, shell, "win32");
  eq(read.params.cmd, "$b=[IO.File]::ReadAllBytes('C:\\x y\\a.txt'); [Console]::OpenStandardOutput().Write($b,0,$b.Length)");
  const readPosix = synthesizeShellCall({ id: "c", name: "Read", canon: "read_file", params: { file_path: "/x y/a.txt" } }, shell, "darwin");
  eq(readPosix.params.cmd, "cat -- '/x y/a.txt'");
  const list = synthesizeShellCall({ id: "c", name: "ListDir", canon: "list_dir", params: {} }, shell, "win32");
  assert(list.params.cmd.includes("Get-ChildItem -Force -LiteralPath '.',") || list.params.cmd.includes("LiteralPath '.'"), "缺省列当前目录");
  assert(list.params.cmd.includes("UTF8.GetBytes($s)"), "目录列表也走字节输出");
  const del = synthesizeShellCall({ id: "c", name: "Delete", canon: "delete_file", params: { path: "a.txt" } }, shell, "linux");
  eq(del.params.cmd, "rm -rf -- 'a.txt'");
});
check("edit_file(win)：old/new 都走 base64，找不到 old_string 时 exit 1", () => {
  const out = synthesizeShellCall({ id: "c", name: "Edit", canon: "edit_file",
    params: { file_path: "a.txt", old_string: "旧'值$", new_string: "新值\n两行" } }, findShellTool(CODEX), "win32");
  const all = [...out.params.cmd.matchAll(/FromBase64String\('([A-Za-z0-9+/=]*)'\)/g)].map((m) => decode(m[1]));
  eq(all, ["旧'值$", "新值\n两行"], "old/new 都能还原");
  assert(out.params.cmd.includes("$t.Contains($o)"), "先查存在性");
  assert(out.params.cmd.includes("exit 1"), "查不到就失败退出");
  assert(out.params.cmd.includes("$t.Replace($o,$n)"), "序号替换（非正则）");
});
check("edit_file(posix)：交给 node 做替换，参数全 base64", () => {
  const out = synthesizeShellCall({ id: "c", name: "Edit", canon: "edit_file",
    params: { path: "/t/a.txt", old_string: "x", new_string: "y" } }, findShellTool(CODEX), "linux");
  assert(out.params.cmd.startsWith("node -e '"), "用 node 兜");
  const args = out.params.cmd.split("' '").slice(-3).map((x) => x.replace(/'$/,""));
  eq(args.map(decode), ["/t/a.txt", "x", "y"]);
});

// --------------------------------------------------------- 不翻 / 兜底说明
check("不在表里的工具一律不硬翻（交给 relay 回说明）", () => {
  const shell = findShellTool(CODEX);
  for (const [name, canon] of [["TodoWrite", "todo_write"], ["Grep", "grep_content"], ["WebFetch", "web_fetch"], ["Skill", "skill"]]) {
    eq(synthesizeShellCall({ id: "c", name, canon, params: { a: 1 } }, shell, "win32"), null, `${name} 不应被翻译`);
    assert(!canSynthesize(canon), `${canon} 不该在可翻译表里`);
  }
  // 表内但参数不全 → 也是 null（宁可不翻，不能发一条会写坏文件的命令）
  eq(synthesizeShellCall({ id: "c", name: "Bash", canon: "run_command", params: {} }, shell, "win32"), null);
  // 没有 shell 工具 → 什么都没法翻
  eq(synthesizeShellCall({ id: "c", name: "Write", canon: "write_file", params: { file_path: "a", content: "b" } }, null, "win32"), null);
});
check("unavailableMessage：告诉 agent 别重试、改用 shell", () => {
  const msg = unavailableMessage("TodoWrite", findShellTool(CODEX));
  assert(msg.includes("TodoWrite"), "点名工具");
  assert(msg.includes("exec_command"), "给出替代品");
  assert(/do not retry|不要重复调用/.test(msg), "别重试的意思要在");
  assert(unavailableMessage("X", null).includes("No shell tool"), "没有 shell 时的说明");
});

for (const [name, ok, msg] of results) console.log(ok ? "PASS " : "FAIL ", name, ok ? "" : `— ${msg}`);
const pass = results.filter((r) => r[1]).length;
console.log(`\n==== ${pass}/${results.length} ====`);
process.exit(pass === results.length ? 0 : 1);
