#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
extract_persona.py —— 从已安装的 AutoClaw 2.x 客户端提取 2.x 网关闸门所需的
应用 persona（system prompt），写到运行时目录。仓库不保存厂商文本（PR#4 维护者建议）。

为什么是"提取"而不是硬编码：persona 随客户端版本变化，硬编码会过期；
且厂商完整 system prompt 属于 IP 灰色地带，不应进公开仓库。

用法：
  python extract_persona.py --out <path>            提取并原子写出（默认 ~/.autoclaw-relay/persona.txt）
  python extract_persona.py --if-stale --out <path> 仅当 out 缺失或客户端比它新时才写
  python extract_persona.py --check --out <path>    只体检：0=一致 3=过期/不一致 1=失败（stdout 为 JSON）

原理（2026-10-07 对 AutoClaw2/resources/app/dist/main.cjs 取证）：
  persona 不是完整字面量，而是 bundle 里的常量拼装：
    var ZWORK_DEFAULT_SYSTEM_PROMPT = [ [...].join(" "), ... ].join("\\n\\n");
  本脚本把这些声明语句**按依赖拓扑序**切片、交给本机 node 求值（让 bundle 自己的
  代码完成拼接，不重实现语义），再过自检（首尾锚点/长度/无 undefined 残留）。
  已实测：提取产物直接通过 2.x 网关五要素闸门（200），与历史捕获文本不同亦可——
  闸门是标记指纹式校验，不与单一固定文本比对。
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

MAIN_JS = "main.cjs"
PERSONA_ANCHOR = "You are AutoClaw."
MIN_LEN = 500
IDENT_RE = re.compile(r"[A-Za-z0-9_]+")
CONST_RE = re.compile(r"[A-Z][A-Z0-9_]{3,}\Z")
VARIANT_VARS = ["ZWORK_DEFAULT_SYSTEM_PROMPT", "ZWORK_LEGAL_VERTICAL_SYSTEM_PROMPT"]


def locate_client():
    """定位客户端主 bundle。返回路径或抛 RuntimeError。"""
    # 测试钩子/非标准安装：直接指定 bundle 路径
    env_bundle = os.environ.get("AUTOCLAW_BUNDLE")
    if env_bundle and os.path.isfile(env_bundle):
        return env_bundle
    candidates = []
    # 1) 常见安装根（NSIS 默认与用户自选盘符）
    roots = []
    pf = os.environ.get("ProgramFiles", "C:\\Program Files")
    pf86 = os.environ.get("ProgramFiles(x86)", "C:\\Program Files (x86)")
    lad = os.environ.get("LOCALAPPDATA", "")
    lad_prog = os.path.join(lad, "Programs") if lad else ""
    for d in (pf, pf86, lad_prog, "C:\\", "D:\\", "E:\\"):
        if os.path.isdir(d):
            roots.append(d)
    for root in roots:
        try:
            for name in os.listdir(root):
                if "autoclaw" in name.lower():
                    base = os.path.join(root, name)
                    candidates.append(os.path.join(base, "resources", "app", "dist", MAIN_JS))
                    candidates.append(os.path.join(base, "resources", "app.asar"))
        except OSError:
            continue
    # 2) 注册表卸载键兜底（NSIS 写 InstallLocation）
    try:
        import winreg
        for hive, path in (
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
            (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
        ):
            try:
                key = winreg.OpenKey(hive, path)
            except OSError:
                continue
            with key:
                i = 0
                while True:
                    try:
                        sub = winreg.EnumKey(key, i); i += 1
                    except OSError:
                        break
                    try:
                        with winreg.OpenKey(key, sub) as sk:
                            disp = winreg.QueryValueEx(sk, "DisplayName")[0]
                            if "autoclaw" in str(disp).lower():
                                loc = winreg.QueryValueEx(sk, "InstallLocation")[0]
                                candidates.append(os.path.join(loc, "resources", "app", "dist", MAIN_JS))
                                candidates.append(os.path.join(loc, "resources", "app.asar"))
                    except OSError:
                        continue
    except ImportError:
        pass

    for c in candidates:
        if c and os.path.isfile(c):
            return c
    raise RuntimeError(
        "未找到已安装的 AutoClaw 客户端（扫描了常见安装目录与卸载注册表）。"
        "请先安装并至少启动登录一次 AutoClaw 2.x。")


def statement(src, frm):
    """从赋值处做括号/引号配平，截取完整声明语句（到分号）。"""
    i = src.index("=", frm)
    depth = 0
    in_str = None
    while i < len(src):
        c = src[i]
        if in_str:
            if c == "\\":
                i += 2
                continue
            if c == in_str:
                in_str = None
        elif c in "\"'`":
            in_str = c
        elif c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == ";" and depth == 0:
            return src[frm:i + 1]
        i += 1
    raise RuntimeError("声明语句未正常终止（bundle 结构与已知配方不符）")


def collect_statements(src, var):
    """取 var 声明并按依赖拓扑排序（依赖的常量声明在前）。"""
    stmt_map = {}

    def collect(name, trail):
        if name in stmt_map or name in trail:
            return
        m = re.search(r"(?:var|let|const)\s+" + re.escape(name) + r"\s*=", src)
        if not m:
            return  # 引用的不是 bundle 顶层常量
        st = statement(src, m.start())
        stmt_map[name] = st
        for d in const_deps(st):
            collect(d, trail | {name})

    def const_deps(st):
        return [t for t in IDENT_RE.findall(st) if CONST_RE.match(t)]

    collect(var, set())
    if var not in stmt_map:
        raise RuntimeError("bundle 里找不到 %s 的声明（客户端版本可能改变了拼装结构）" % var)

    order, done = [], set()

    def emit(name):
        if name in done:
            return
        done.add(name)
        st = stmt_map.get(name)
        if st is None:
            return
        for d in const_deps(st):
            if d in stmt_map:
                emit(d)
        order.append(st)

    emit(var)
    return order


def extract_persona(bundle_path):
    """切片 + node 求值，返回 persona 文本。优先 DEFAULT 变体，退回 LEGAL_VERTICAL。"""
    with open(bundle_path, "r", encoding="latin-1") as f:
        src = f.read()
    errors = []
    for var in VARIANT_VARS:
        try:
            order = collect_statements(src, var)
        except RuntimeError as e:
            errors.append("%s: %s" % (var, e))
            continue
        js = "\n".join(order) + "\nconsole.log(JSON.stringify(%s));\n" % var
        fd, tmp = tempfile.mkstemp(suffix=".mjs")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(js)
            r = subprocess.run(["node", tmp], capture_output=True, text=True,
                               encoding="utf-8", timeout=120)
            if r.returncode != 0:
                errors.append("%s: node 求值失败: %s" % (var, (r.stderr or "").strip()[:200]))
                continue
            persona = json.loads(r.stdout.strip())
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
        problems = self_check(persona)
        if problems:
            errors.append("%s: %s" % (var, "；".join(problems)))
            continue
        return persona
    raise RuntimeError("提取失败（所有变体）—— " + "；".join(errors))


def self_check(persona):
    """产物体检：任何一条不过都视为提取失败，绝不把可疑文本写进运行时。"""
    problems = []
    if not persona or not isinstance(persona, str):
        problems.append("产物为空")
        return problems
    if not persona.startswith(PERSONA_ANCHOR):
        problems.append("未以 %r 开头" % PERSONA_ANCHOR)
    if len(persona) < MIN_LEN:
        problems.append("长度 %d < %d（疑似取到片段）" % (len(persona), MIN_LEN))
    low = persona.lower()
    if "undefined" in low or "[object object]" in low:
        problems.append("含 undefined/[object object] 残留（依赖未就绪）")
    if persona.count("\n\n") < 1:
        problems.append("无分段结构（疑似单片段）")
    return problems


def write_atomic(path, text):
    d = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".persona-")
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    os.replace(tmp, path)


def bundle_mtime(bundle):
    try:
        return os.stat(bundle).st_mtime
    except OSError:
        return 0


def out_mtime(path):
    try:
        return os.stat(path).st_mtime
    except OSError:
        return -1


def main():
    ap = argparse.ArgumentParser(description="从 AutoClaw 客户端提取 2.x 闸门 persona")
    ap.add_argument("--out", default=os.path.join(os.path.expanduser("~"), ".autoclaw-relay", "persona.txt"))
    ap.add_argument("--if-stale", action="store_true", help="仅当 out 缺失或客户端比它新时才写")
    ap.add_argument("--check", action="store_true", help="只体检不写盘（0 一致 / 3 过期 / 1 失败）")
    args = ap.parse_args()

    try:
        bundle = locate_client()
        persona = extract_persona(bundle)
    except Exception as e:  # noqa: BLE001 —— 显式失败，绝不静默用旧文本
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 1

    fresh = True
    if args.if_stale and os.path.isfile(args.out):
        # 内容一致就不写（保留既有 mtime 语义）；不一致且客户端更新才视为过期
        with open(args.out, "r", encoding="utf-8") as f:
            current = f.read()
        if current == persona:
            print(json.dumps({"ok": True, "action": "unchanged", "bundle": bundle,
                              "chars": len(persona)}, ensure_ascii=False))
            return 0
        fresh = bundle_mtime(bundle) > out_mtime(args.out)
        if not fresh:
            # 内容不一致但客户端没更新：保守保留现有文件，报告差异
            print(json.dumps({"ok": True, "action": "kept", "bundle": bundle,
                              "chars": len(persona), "note": "提取结果与现有 persona 不同且客户端未更新，已保留现有文件"}, ensure_ascii=False))
            return 0

    if args.check:
        # 体检模式：比较 out 与新提取
        try:
            with open(args.out, "r", encoding="utf-8") as f:
                current = f.read()
        except OSError:
            current = None
        same = current == persona
        print(json.dumps({"ok": True, "match": same, "bundle": bundle,
                          "chars": len(persona)}, ensure_ascii=False))
        return 0 if same else 3

    write_atomic(args.out, persona)
    print(json.dumps({"ok": True, "action": "written", "bundle": bundle,
                      "chars": len(persona)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
