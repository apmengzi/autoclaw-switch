// Comate 云端 agent 的工具词汇 → Codex 客户端的工具词汇。
//
// 上游 agent 说的是 IDE 词汇（Bash/Read/Write/Edit/Delete/ListDir…，帧里就是这些
// 名字），而 Codex 0.160 只声明一个执行工具：exec_command{cmd}（实测抓包：tools =
// exec_command / write_stdin / request_user_input / view_image / multi_agent_v1
// 命名空间 / goals / web_search，没有任何文件类工具，也没有 apply_patch）。
// 名字对不上时 Codex 会直接拒收：`error=unsupported call: Bash`。
//
// 所以这里把上游调用翻译成 exec_command 的一条命令行。两条原则：
//   1. 命令交给 Codex 自己执行——沙箱、审批、工作目录全部仍归 Codex 管，
//      本模块只做"翻译"，不替客户端动文件系统（否则会绕过 Codex 的安全边界）。
//   2. 正文/待替换文本一律走 base64：PowerShell 的 here-string 遇到内容里出现
//      结束符就崩，转义引号又受 shell 方言影响，base64 只有 [A-Za-z0-9+/=]。
//
// 纯函数，无 IO，离线单测见 comate/test_responses.mjs。
const B64 = (s) => Buffer.from(String(s ?? ""), "utf8").toString("base64");

// 客户端可能用来执行命令的工具名，按优先级取第一个声明了的。Codex 0.160 是
// exec_command；shell / local_shell 是给它其它版本与配置留的余量（custom 形态的
// local_shell 参数名是 input，所以参数名按声明的 schema 现取，不写死）。
const SHELL_TOOL_PRIORITY = ["exec_command", "shell", "local_shell", "bash", "cmd", "run_command"];

export function findShellTool(clientTools) {
  if (!clientTools?.get) return null;
  for (const name of SHELL_TOOL_PRIORITY) {
    const props = clientTools.get(name);
    if (props === undefined) continue;
    // props 为 null 表示声明里没给出属性表（自定义工具常见），此时按名字猜参数名
    const argKey = !props ? (name === "exec_command" ? "cmd" : "command")
      : props.has("cmd") ? "cmd"
      : props.has("input") ? "input"
      : props.has("command") ? "command"
      : null;
    if (argKey) return { name, argKey };
  }
  return null;
}

// 上游参数名各家不同（同一工具不同版本的帧里都见过），取值时按可能性依次试。
const pick = (params, keys) => {
  for (const k of keys) {
    const v = params?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};

const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const shQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const isWin = (platform) => String(platform || "").startsWith("win");

// PowerShell 5.1 往外写字符串时按控制台代码页转一道（中文机器上是 GBK），非 ASCII
// 到客户端那一侧就成了乱码——实测 Get-Content 读一份中文文件回来已经烂了。所以凡
// "要把内容交给客户端看"的命令一律绕开字符串编码：读出字节直接写标准输出，客户端
// 按 UTF-8 解即可。写盘那条本来就走 base64 字节通道，不受影响。
const psWriteBytes = (bytesExpr) => `$b=${bytesExpr}; [Console]::OpenStandardOutput().Write($b,0,$b.Length)`;
const psListBytes = (p) =>
  `$s=(Get-ChildItem -Force -LiteralPath ${p} | Select-Object Mode,Length,Name | Format-Table -AutoSize | Out-String -Width 200); `;

// ------------------------------------------------------------------ 命令构造
// 每个构造器返回一条命令行字符串，或 null（参数不全 → 交给上层回一条"不可用"说明）。
const BUILDERS = {
  run_command(params) {
    const command = pick(params, ["command", "cmd", "script", "code"]);
    return typeof command === "string" && command.trim() ? command : null;
  },

  read_file(params, platform) {
    const p = pick(params, ["file_path", "path", "file", "absolute_path", "target_file"]);
    if (typeof p !== "string" || !p.trim()) return null;
    return isWin(platform) ? psWriteBytes(`[IO.File]::ReadAllBytes(${psQuote(p)})`)
      : `cat -- ${shQuote(p)}`;
  },

  list_dir(params, platform) {
    const p = pick(params, ["path", "dir_path", "directory", "folder", "target_directory"]) ?? ".";
    if (typeof p !== "string") return null;
    return isWin(platform)
      ? psListBytes(psQuote(p)) + psWriteBytes("[Text.Encoding]::UTF8.GetBytes($s)")
      : `ls -la -- ${shQuote(p)}`;
  },

  write_file(params, platform) {
    const p = pick(params, ["file_path", "path", "file", "absolute_path", "target_file"]);
    const content = pick(params, ["content", "file_text", "text", "new_content", "contents"]);
    if (typeof p !== "string" || !p.trim() || typeof content !== "string") return null;
    if (isWin(platform)) {
      return `$d=[IO.Path]::GetDirectoryName(${psQuote(p)}); if($d){[IO.Directory]::CreateDirectory($d)|Out-Null}; `
        + `[IO.File]::WriteAllBytes(${psQuote(p)},[Convert]::FromBase64String('${B64(content)}'))`;
    }
    return `mkdir -p "$(dirname -- ${shQuote(p)})" && printf %s '${B64(content)}' | (base64 -d 2>/dev/null || base64 -D) > ${shQuote(p)}`;
  },

  edit_file(params, platform) {
    const p = pick(params, ["file_path", "path", "file", "absolute_path", "target_file"]);
    const oldS = pick(params, ["old_string", "old_str", "old_text", "search", "find"]);
    const newS = pick(params, ["new_string", "new_str", "new_text", "replace", "replacement"]);
    if (typeof p !== "string" || !p.trim() || typeof oldS !== "string" || typeof newS !== "string") return null;
    const o = B64(oldS), n = B64(newS);
    if (isWin(platform)) {
      // .Replace 是序号比较（非正则），$t 全程当字节读回再按 UTF-8 写回，不留 BOM
      return `$p=${psQuote(p)}; $b=[Text.Encoding]::UTF8; $t=$b.GetString([IO.File]::ReadAllBytes($p)); `
        + `$o=$b.GetString([Convert]::FromBase64String('${o}')); $n=$b.GetString([Convert]::FromBase64String('${n}')); `
        + `if(-not $t.Contains($o)){ Write-Error 'old_string not found in ${String(p).replace(/'/g, "''")}'; exit 1 }; `
        + `[IO.File]::WriteAllBytes($p,$b.GetBytes($t.Replace($o,$n)))`;
    }
    return `node -e 'const fs=require("fs");const[p,o,n]=process.argv.slice(1).map(x=>Buffer.from(x,"base64").toString("utf8"));`
      + `const t=fs.readFileSync(p,"utf8");if(!t.includes(o)){console.error("old_string not found");process.exit(1)}`
      + `fs.writeFileSync(p,t.split(o).join(n))' '${B64(p)}' '${o}' '${n}'`;
  },

  delete_file(params, platform) {
    const p = pick(params, ["file_path", "path", "file", "absolute_path"]);
    if (typeof p !== "string" || !p.trim()) return null;
    return isWin(platform)
      ? `Remove-Item -Force -Recurse -LiteralPath ${psQuote(p)}`
      : `rm -rf -- ${shQuote(p)}`;
  },
};

// 上游工具名 → 构造器。键是 canonical 名（Write→write_file 等由调用方先归一）。
// 没列在这里的工具不硬翻：回一条说明让 agent 自己用 exec_command 表达（它有 shell）。
const SYNTHESIZABLE = {
  run_command: "run_command", read_file: "read_file", write_file: "write_file",
  edit_file: "edit_file", delete_file: "delete_file", list_dir: "list_dir",
};

export function canSynthesize(canonName) {
  return Object.prototype.hasOwnProperty.call(SYNTHESIZABLE, canonName);
}

// canonical 名 + 参数 → 客户端的 exec_command 调用；不能翻时返回 null。
export function synthesizeShellCall(call, shell, platform = process.platform) {
  const kind = SYNTHESIZABLE[call?.canon];
  if (!kind || !shell) return null;
  const cmd = BUILDERS[kind](call.params || {}, platform);
  if (!cmd) return null;
  // 只给 cmd。exec_command 的 justification 是给"申请越权（require_escalated）"用的，
  // 带上它 Codex 会直接拒收：`justification` requires an explicit `sandbox_permissions`
  // ——桥接不该替客户端申请越权，沙箱怎么算由 Codex 自己定。
  return { id: call.id, name: shell.name, params: { [shell.argKey]: cmd } };
}

// 客户端确实执行不了、也没法翻译时，回给上游的说明（由 relay 当作工具结果送回）。
export function unavailableMessage(rawName, shell) {
  const hint = shell
    ? `Use "${shell.name}" (the shell) to do the same thing`
    : "No shell tool is available on this client";
  return `[A-SWITCH bridge] Tool "${rawName}" is not available on this client — do not retry it. `
    + `${hint}; 请改用 shell 命令完成同样的事，不要重复调用本工具。`;
}

export const __test = { BUILDERS, psQuote, shQuote, B64 };
