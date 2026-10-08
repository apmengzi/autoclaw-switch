#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
extract_persona.py 的沙箱回归测试：`python bridge/test_extract_persona.py`

全部跑在临时目录的合成 bundle 上（结构与真实客户端 main.cjs 同形：
var 常量数组 + .join 拼装），不读、不依赖真实 AutoClaw 客户端。
覆盖：正常提取（依赖拓扑序）、自检拦截（锚点错/太短/undefined 残留）、
--if-stale 的三种分支（缺失写/一致不写/客户端更新才写）、--check 退出码、
AUTOCLAW_BUNDLE 测试钩子、客户端缺失的显式报错。
"""
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
EXTRACTOR = os.path.join(HERE, "extract_persona.py")

results = []


def t(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS" if ok else "FAIL") + "  " + name + ("" if ok else "  <-- " + detail))


def run(args, env_extra=None):
    env = dict(os.environ)
    env.pop("AUTOCLAW_BUNDLE", None)
    if env_extra:
        env.update(env_extra)
    return subprocess.run([sys.executable, EXTRACTOR] + args,
                          capture_output=True, text=True, encoding="utf-8",
                          timeout=120, env=env)


def last_json(out):
    lines = [l for l in (out or "").strip().split("\n") if l.startswith("{")]
    return json.loads(lines[-1]) if lines else {}


def make_bundle(tmp, persona_text, anchor_ok=True, undefined=False):
    """合成与客户端同形的 bundle：数组常量 + join 拼装 + 依赖引用。"""
    body = persona_text.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")
    anchor = "You are AutoClaw. Answer the user directly and concisely." if anchor_ok else "You are SomeoneElse."
    tail = " and some undefined is here" if undefined else ""
    return "\n".join([
        "var UNRELATED_TOP = 42;",
        'var PERSONA_TONE_BLOCK = `# Tone and style\\n' + body + '`;',
        'var PERSONA_LANGUAGE_BLOCK = [',
        '  "Language discipline: output follows the language of the user\'s latest message.",',
        '  "Process narration: say in one sentence what you are about to do before the first tool call.",',
        '].join(" ");',
        'var ZWORK_DEFAULT_SYSTEM_PROMPT = [',
        '  ["' + anchor + '", PERSONA_LANGUAGE_BLOCK].join(" "),',
        '  PERSONA_TONE_BLOCK + "' + tail + '",',
        '].join("\\n\\n");',
        "function zworkSystemIdentityPromptFor(input) {",
        "  return ZWORK_DEFAULT_SYSTEM_PROMPT;",
        "}",
        "",
    ])


def main():
    tmp = tempfile.mkdtemp(prefix="persona-test-")
    filler = ("You should be concise, direct, and to the point. " * 12)
    good_text = filler + "Keep brand names and proper nouns untranslated. Editing source code follows the code's own conventions."

    # 1) 正常提取：依赖拓扑序（PERSONA_TONE_BLOCK 引用在前声明在后也不怕）
    bundle = os.path.join(tmp, "main.cjs")
    with open(bundle, "w", encoding="latin-1") as f:
        f.write(make_bundle(tmp, good_text))
    out1 = os.path.join(tmp, "persona1.txt")
    r = run(["--out", out1], {"AUTOCLAW_BUNDLE": bundle})
    j = last_json(r.stdout)
    t("1a 正常提取成功", r.returncode == 0 and j.get("ok") and j.get("action") == "written", r.stdout + r.stderr)
    got = open(out1, encoding="utf-8").read() if os.path.isfile(out1) else ""
    t("1b 产物以锚点开头且包含两个依赖块",
      got.startswith("You are AutoClaw.") and "Language discipline" in got and "Tone and style" in got,
      "len=%d head=%r" % (len(got), got[:60]))
    t("1c 产物不含 undefined 残留", "undefined" not in got)

    # 2) 自检拦截：锚点错
    bad1 = os.path.join(tmp, "bad-anchor.cjs")
    with open(bad1, "w", encoding="latin-1") as f:
        f.write(make_bundle(tmp, good_text, anchor_ok=False))
    r = run(["--out", os.path.join(tmp, "no.txt")], {"AUTOCLAW_BUNDLE": bad1})
    j = last_json(r.stdout)
    t("2a 锚点错误被拒绝（exit 1 + error）", r.returncode == 1 and not j.get("ok", True), r.stdout)
    t("2b 错误信息可读（聚合各变体原因）", r.returncode == 1 and "You are AutoClaw" in (j.get("error") or ""), j.get("error", ""))

    # 3) 自检拦截：undefined 残留
    bad2 = os.path.join(tmp, "undefined.cjs")
    with open(bad2, "w", encoding="latin-1") as f:
        f.write(make_bundle(tmp, good_text, undefined=True))
    r = run(["--out", os.path.join(tmp, "no2.txt")], {"AUTOCLAW_BUNDLE": bad2})
    j = last_json(r.stdout)
    t("3 undefined 残留被拒绝", r.returncode == 1 and "undefined" in (j.get("error") or ""), r.stdout)

    # 4) --if-stale 三分支
    out4 = os.path.join(tmp, "persona4.txt")
    r = run(["--if-stale", "--out", out4], {"AUTOCLAW_BUNDLE": bundle})
    t("4a out 缺失 → written", last_json(r.stdout).get("action") == "written", r.stdout)
    r = run(["--if-stale", "--out", out4], {"AUTOCLAW_BUNDLE": bundle})
    t("4b 内容一致 → unchanged", last_json(r.stdout).get("action") == "unchanged", r.stdout)
    # 内容不同 + 客户端不比它新 → kept
    time.sleep(0.05)
    with open(out4, "w", encoding="utf-8") as f:
        f.write(good_text + "\n\nstale-seed")
    os.utime(out4, (time.time() + 3600, time.time() + 3600))  # out 比客户端新
    r = run(["--if-stale", "--out", out4], {"AUTOCLAW_BUNDLE": bundle})
    t("4c 内容不同但客户端未更新 → kept", last_json(r.stdout).get("action") == "kept", r.stdout)
    # 内容不同 + 客户端更新 → written（模拟客户端升级）
    os.utime(out4, (time.time() - 3600, time.time() - 3600))
    r = run(["--if-stale", "--out", out4], {"AUTOCLAW_BUNDLE": bundle})
    t("4d 客户端比 out 新 → written", last_json(r.stdout).get("action") == "written", r.stdout)

    # 5) --check 退出码：一致 0 / 不一致 3
    with open(out4, "w", encoding="utf-8") as f:
        f.write(good_text + "\n\nstale-seed")   # 4d 已把 out4 覆盖成提取产物，先改回不一致内容
    r = run(["--check", "--out", out4], {"AUTOCLAW_BUNDLE": bundle})
    t("5a --check 不一致 → exit 3", r.returncode == 3 and last_json(r.stdout).get("match") is False, r.stdout)
    with open(out4, "w", encoding="utf-8") as f:
        f.write(got)
    r = run(["--check", "--out", out4], {"AUTOCLAW_BUNDLE": bundle})
    t("5b --check 一致 → exit 0", r.returncode == 0 and last_json(r.stdout).get("match") is True, r.stdout)

    # 6) bundle 无效（存在但没有 persona 声明）：显式报错，绝不静默写盘
    bad3 = os.path.join(tmp, "empty.cjs")
    with open(bad3, "w", encoding="latin-1") as f:
        f.write("var UNRELATED = 1;\n")
    r = run(["--out", os.path.join(tmp, "no3.txt")], {"AUTOCLAW_BUNDLE": bad3})
    j = last_json(r.stdout)
    t("6 bundle 无 persona 声明 → exit 1 + 聚合错误", r.returncode == 1 and not j.get("ok", True)
      and "提取失败" in (j.get("error") or ""), r.stdout)

    # 7) 原子写：产物无临时文件残留
    leftovers = [f for f in os.listdir(tmp) if f.startswith(".persona-")]
    t("7 无临时文件残留", not leftovers, str(leftovers))

    print()
    passed = sum(1 for _, ok, _ in results if ok)
    print("==== %d/%d ====" % (passed, len(results)))
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
