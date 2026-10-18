// Windows 真机验证 base64 落盘那条命令：`node comate/test_codex_shell_win.mjs`
//
// 单测只断言了"命令行里是合法 base64"，但真跑起来才算数：PowerShell 的语法、
// UTF-8 无 BOM 写回、目录自动创建、内容里的引号/换行/emoji 都得真的落对。
// 非 Windows 直接跳过（命令构造本身另有跨平台单测）。
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findShellTool, synthesizeShellCall } from "./codex_shell.mjs";

if (process.platform !== "win32") {
  console.log("skip: 只在 Windows 上跑（PowerShell 命令真机验证）");
  process.exit(0);
}

const CODEX_TOOLS = new Map([["exec_command", new Set(["cmd", "justification", "workdir"])]]);
const shell = findShellTool(CODEX_TOOLS);
const results = [];
const check = (name, fn) => {
  try { fn(); results.push([name, true]); }
  catch (e) { results.push([name, false, e.message]); }
};
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || "not equal"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

const base = mkdtempSync(join(tmpdir(), "aswitch-shell-"));
const run = (cmd) => spawnSync("powershell", ["-NoProfile", "-Command", cmd]);
const synth = (params) => synthesizeShellCall({ id: "c", name: "Write", canon: "write_file", params }, shell, "win32").params.cmd;

const NASTY = "第一行 'single' \"double\"\n第二行 $env:PATH ` 反引号\n第三行 emoji 🙂 与中文\t制表\n末尾无换行";
const target = join(base, "子 目录", "hello.txt");

check("write_file：base64 落盘，逐字节一致（含引号/换行/emoji/空格路径）", () => {
  const r = run(synth({ file_path: target, content: NASTY }));
  if (r.status !== 0) throw new Error(`powershell exit ${r.status}: ${r.stderr.slice(0, 300)}`);
  eq(readFileSync(target, "utf8"), NASTY, "文件内容");
});

check("write_file：写回是 UTF-8 无 BOM", () => {
  const buf = readFileSync(target);
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) throw new Error("带上了 BOM");
  eq(buf.length, Buffer.byteLength(NASTY, "utf8"), "字节数");
});

check("read_file：字节直出，非 ASCII 逐字节一致（不被控制台代码页转烂）", () => {
  const cmd = synthesizeShellCall({ id: "c", name: "Read", canon: "read_file", params: { file_path: target } }, shell, "win32").params.cmd;
  const r = run(cmd);
  eq(r.status, 0, "exit 0");
  eq(r.stdout.toString("utf8").replace(/\r\n/g, "\n"), NASTY, "读回内容");
});

check("edit_file：旧串替换成新串，未命中时非零退出", () => {
  const cmd = synthesizeShellCall({ id: "c", name: "Edit", canon: "edit_file",
    params: { file_path: target, old_string: "emoji 🙂", new_string: "emoji OK" } }, shell, "win32").params.cmd;
  eq(run(cmd).status, 0, "替换成功");
  if (!readFileSync(target, "utf8").includes("emoji OK")) throw new Error("没替换上");
  const miss = synthesizeShellCall({ id: "c", name: "Edit", canon: "edit_file",
    params: { file_path: target, old_string: "不存在的串", new_string: "x" } }, shell, "win32").params.cmd;
  if (run(miss).status === 0) throw new Error("未命中却成功了");
});

check("delete_file / list_dir：删得掉、列得出", () => {
  const list = synthesizeShellCall({ id: "c", name: "ListDir", canon: "list_dir", params: { path: join(base, "子 目录") } }, shell, "win32").params.cmd;
  const r = run(list);
  eq(r.status, 0, "列目录 exit 0");
  if (!r.stdout.toString("utf8").includes("hello.txt")) throw new Error("列目录看不到文件");
  const del = synthesizeShellCall({ id: "c", name: "Delete", canon: "delete_file", params: { file_path: target } }, shell, "win32").params.cmd;
  eq(run(del).status, 0, "删除 exit 0");
  if (readdirSync(join(base, "子 目录")).includes("hello.txt")) throw new Error("文件还在");
});

for (const [name, ok, msg] of results) console.log(ok ? "PASS " : "FAIL ", name, ok ? "" : `— ${msg}`);
rmSync(base, { recursive: true, force: true });
const pass = results.filter((r) => r[1]).length;
console.log(`\n==== ${pass}/${results.length} ====`);
process.exit(pass === results.length ? 0 : 1);
