#!/usr/bin/env node
/**
 * 真机探针：确认 /v2/execute 的流式行为（消耗 Comate 额度，手动跑）。
 *
 *   node comate/probe_stream.mjs [prompt]
 *
 * 打点内容：响应状态与 content-type、每一条 SSE 帧的相对到达时间、
 * 帧类型序列、reasoningDelta / delta 是否随着时间分段到达。
 * 结论用于判定 relay 该走 true-streaming 还是降级到 execute-sync。
 */
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Comate", "User", "settings.json");
const s = JSON.parse(readFileSync(SETTINGS, "utf8"));
const license = s["baidu.comate.license"];
if (!license) { console.error("未登录 Comate（settings.json 无 baidu.comate.license）"); process.exit(1); }

const BASE = process.env.COMATE_RELAY_BASE || "https://comate.baidu.com";
const API = BASE + "/api/aidevops/autocomate/rest/autowork";
const HEAD = {
  "Content-Type": "application/json", "X-Source": "COMATE", "User-Agent": "axios/1.16.1",
  Accept: "application/json, text/plain, */*", "Accept-Encoding": "gzip, compress, deflate, br",
  Connection: "keep-alive", "Accept-Language": "zh-CN,zh",
  "login-name": license, "Uuap-login-name": license, "plugin-version": "zulucli-4.13.0", "x-skip-fcnap": "yes",
};
const prompt = process.argv[2] || "用一句话说明你现在能做什么，然后回答 1+1 等于几";

function post(path, body, extra = {}, stream = false) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const req = httpsRequest(BASE + path, { method: "POST", headers: { ...HEAD, "Content-Length": data.length, ...extra } }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers, res });
    });
    req.on("error", reject);
    req.setTimeout(600000, () => req.destroy(new Error("timeout")));
    req.write(data);
    req.end();
    if (stream) return;
  });
}
async function postJson(path, body, extra = {}) {
  const { res } = await post(path, body, extra);
  let t = "";
  for await (const c of res) t += c.toString("utf8");
  return t;
}

const trace = randomUUID();
const conv = JSON.parse(await postJson("/api/aidevops/autocomate/rest/autowork/v2/conversation",
  { username: license, ide: "zulucli", ideVersion: "1.8.1", pluginVersion: "4.13.0", agentId: 1 }, { "X-Trace-Id": trace }));
console.log("conversation:", JSON.stringify(conv).slice(0, 120));
const task = JSON.parse(await postJson("/api/aidevops/autocomate/rest/autowork/v2/task",
  { username: license, ide: "zulucli", ideVersion: "1.8.1", pluginVersion: "4.13.0", agentId: 1, conversationId: conv.data.id,
    agentInfo: { agentName: "Agent", isProjectAgent: false, canInvokeAgents: true, isCustomAgent: false } }, { "X-Trace-Id": trace }));
console.log("task:", JSON.stringify(task).slice(0, 120));

const body = {
  username: license, ide: "zulucli", ideVersion: "1.8.1", pluginVersion: "4.13.0",
  taskId: task.data.taskId, conversationId: conv.data.id, agentId: 1,
  uploadBaseInfo: {
    os: "Windows 10", osVersion: "Windows 10", extName: "zulucli", extVersion: "4.13.0",
    ideType: "zulucli", ideName: "zulucli", ideVersion: "1.8.1", vcsRepo: "", vcsBranchName: "",
    username: license, license, pluginVersion: "4.13.0", device: randomUUID(), triggerSource: "Agent",
  },
  query: prompt, modelKey: "auto",
  sysInfo: { os: "Windows 10", defaultShell: "cmd.exe", homeDir: homedir(), installedCommands: ["node", "npm", "python"],
    notInstalledCommands: [], workspacePath: process.cwd(), workspaceRoots: [process.cwd()] },
  skillInfos: [], hasMcp: false, isUserQuery: true, isMockQuery: false, localIndex: false, contexts: [],
  toolUseResults: [], subAgents: [], agentVersion: "12", isFirstQuery: true, enableMemory: false, systemReminder: "",
  extendUserQueryInfo: { commands: [], skills: [], subagents: [], rules: [] },
  extend: { isMultiWorkspace: false, useWorkflow: false }, sendMode: "normal", queryId: randomUUID(),
  langfuseTraceId: "", langfuseTraceparent: "",
  agentInfo: { agentName: "Agent", isProjectAgent: false, canInvokeAgents: true, isCustomAgent: false },
};

const t0 = Date.now();
const { status, headers, res } = await post("/api/aidevops/autocomate/rest/autowork/v2/execute", body,
  { "X-Trace-Id": randomUUID(), Accept: "text/event-stream" }, true);
console.log(`\nPOST /v2/execute -> ${status} content-type=${headers["content-type"]} encoding=${headers["content-encoding"] || "-"}`);
if (status !== 200 || !String(headers["content-type"]).includes("text/event-stream")) {
  let t = ""; for await (const c of res) t += c.toString("utf8");
  console.log("非 SSE 响应体：", t.slice(0, 400));
  process.exit(2);
}

let buf = "", n = 0, text = "", think = "", lastKind = "", firstTextAt = 0, firstThinkAt = 0;
for await (const chunk of res) {
  buf += chunk.toString("utf8");
  const lines = buf.split("\n"); buf = lines.pop() ?? "";
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("data:")) { if (t) console.log(`  [${String(Date.now() - t0).padStart(6)}ms] ${line.slice(0, 80)}`); continue; }
    const payload = t.slice(5).trim();
    if (!payload) continue;
    let f; try { f = JSON.parse(payload); } catch { console.log(`  [${String(Date.now() - t0).padStart(6)}ms] 坏帧 ${payload.slice(0, 60)}`); continue; }
    n++;
    const c = f.content || {}, d = c.detail || {};
    const kind = c.type + (d.reasoningDelta ? "(think)" : d.delta ? "(text)" : d.toolUse ? "(tool)" : d.end ? "(end)" : "");
    if (kind !== lastKind) console.log(`  [${String(Date.now() - t0).padStart(6)}ms] 帧#${n} ${kind}`);
    if (d.reasoningDelta) { think += d.reasoningDelta; if (!firstThinkAt) firstThinkAt = Date.now() - t0; }
    if (d.delta) { text += d.delta; if (!firstTextAt) firstTextAt = Date.now() - t0; }
    if (d.toolUse) console.log(`       toolUse: ${JSON.stringify(d.toolUse).slice(0, 160)}`);
    if (c.type === "EXCEPTION" || c.type === "QUOTA_EXCEED" || c.type === "DOWNGRADE") console.log("       终止帧:", JSON.stringify(d).slice(0, 200));
  }
}
console.log(`\n总计 ${n} 帧，${Date.now() - t0}ms`);
console.log(`首条思维 ${firstThinkAt}ms，首条正文 ${firstTextAt}ms`);
console.log(`思维链 ${think.length} 字：${think.slice(0, 120)}`);
console.log(`正文 ${text.length} 字：${text.slice(0, 120)}`);
