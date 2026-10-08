// Probe /chat/completion variants. Usage:
//   node doubao/probe.mjs "question" [--agent] [--think] [--effort=N] [--conv=<id>] [--quiet]
// Reads cookies from ~/.doubao-relay/cookies-cdp.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OUT = path.join(os.homedir(), ".doubao-relay");
const jar = JSON.parse(fs.readFileSync(path.join(OUT, "cookies-cdp.json"), "utf8"));
const cookies = jar.cookies || jar;
const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const pick = (n) => (cookies.find((c) => c.name === n) || {}).value || "";

const args = process.argv.slice(2);
const text = args.find((a) => !a.startsWith("--")) || "1+1等于几";
const flag = (n) => args.includes("--" + n);
const opt = (n, d) => {
  const a = args.find((x) => x.startsWith("--" + n + "="));
  return a ? a.slice(n.length + 3) : d;
};
const agentMode = flag("agent") ? 1 : 0;
const deepThink = flag("think") ? 9 : 0;
const effort = opt("effort", deepThink ? "5" : "0");
const convArg = opt("conv", "");
const quiet = flag("quiet");

const CAP = JSON.parse(fs.readFileSync(path.join(OUT, "captured.json"), "utf8"));
const comp = CAP.find((x) => /chat\/completion/.test(x.url));
const capUrl = new URL(comp.url);
const deviceId = pick("device_id") || capUrl.searchParams.get("device_id");
const msToken = pick("msToken") || capUrl.searchParams.get("msToken");

export function buildUrl() {
  const q = new URLSearchParams({
    aid: "1044603", channel: "win", client_platform: "pc_client", device_platform: "web",
    doubao_device_platform: "desktop", doubao_pc_version: "2.31.10", language: "zh",
    pc_version: "2.31.10", pkg_type: "release_version", real_aid: "1044603", region: "CN",
    runtime: "web", runtime_version: "3.39.0", samantha_web: "1", sys_region: "CN",
    tz_name: "Asia/Shanghai", "use-olympus-account": "1", version_code: "20800",
    web_id: capUrl.searchParams.get("web_id"), web_platform: "desktop",
    web_tab_id: capUrl.searchParams.get("web_tab_id"), chromium_version: "147.0.7727.149",
    device_id: deviceId, fp: "verify_" + deviceId, tea_uuid: deviceId,
  });
  if (msToken) q.set("msToken", msToken);
  return "https://www.doubao.com/chat/completion?" + q.toString();
}

export function buildBody(txt, { conversationId = "", reasoningEffort = "0", needDeepThink = 0, agent = 0 } = {}) {
  const uuid = () => crypto.randomUUID();
  return {
    client_meta: {
      local_conversation_id: conversationId ? "" : uuid(),
      conversation_id: conversationId,
      bot_id: "7338286299411103781",
      last_section_id: "",
      last_message_index: null,
      local_permissions: [
        { permission_name: "ACCESS_COARSE_LOCATION", status: 2 },
        { permission_name: "ACCESS_FINE_LOCATION", status: 2 },
        { permission_name: "ACCESS_BACKGROUND_LOCATION", status: 2 },
      ],
    },
    messages: [{
      local_message_id: uuid(),
      content_block: [{
        block_type: 10000,
        content: { text_block: { text: txt, icon_url: "", icon_url_dark: "", summary: "" } },
        pc_event_block: "", block_id: uuid(), parent_id: "", meta_info: [], append_fields: [],
      }],
      message_status: 0,
    }],
    option: {
      send_message_scene: "", create_time_ms: Date.now(), collect_id: "", is_audio: false,
      answer_with_suggest: false, agent_mode: agent, tts_switch: false,
      need_deep_think: needDeepThink, click_clear_context: false, from_suggest: false,
      is_regen: false, is_replace: false, is_from_click_option: false,
      is_from_click_softlink: false, disable_sse_cache: false, select_text_action: "",
      is_select_text: false, resend_for_regen: false, scene_type: 0, unique_key: uuid(),
      start_seq: 0, need_create_conversation: !conversationId,
      sse_recv_event_options: { support_chunk_delta: true },
      ...(needDeepThink ? { reasoning_effort: reasoningEffort } : {}),
    },
  };
}

export async function streamChat(body, onEvent, { timeoutMs = 90000 } = {}) {
  const res = await fetch(buildUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json", "agw-js-conv": "str", accept: "*/*",
      origin: "https://www.doubao.com", referer: "https://www.doubao.com/",
      cookie: cookieHeader,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 SamanthaDoubaoWork/2.31.10",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { status: res.status, events: 0 };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", ev = {}, n = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (!line.trim()) { if (ev.event) { n++; onEvent(ev); ev = {}; } continue; }
      const m = line.match(/^(id|event|data):\s?(.*)$/);
      if (m) ev[m[1]] = m[2];
    }
  }
  return { status: res.status, events: n };
}

if ((process.argv[1] || "").replace(/\\/g, "/").endsWith("/doubao/probe.mjs")) {
  const body = buildBody(text, {
    conversationId: convArg, reasoningEffort: effort, needDeepThink: deepThink, agent: agentMode,
  });
  console.log(`# agent=${agentMode} think=${deepThink} effort=${effort} conv=${convArg || "(new)"}`);
  let out = "";
  const t0 = Date.now();
  const r = await streamChat(body, (e) => {
    if (!quiet) console.log(`  [${e.event}] ${String(e.data || "").slice(0, 160)}`);
    if (e.event === "STREAM_MSG_NOTIFY") {
      try {
        for (const b of JSON.parse(e.data).content?.content_block || [])
          if (b.block_type === 10000) out += b.content?.text_block?.text || "";
      } catch {}
    }
    if (e.event === "SSE_REPLY_END" && /end_type":1/.test(e.data || "")) {
      try { console.log("# brief:", JSON.parse(e.data).msg_finish_attr?.brief?.slice(0, 200)); } catch {}
    }
  });
  console.log(`\n# status=${r.status} events=${r.events} ${Date.now() - t0}ms`);
  console.log("# answer:", out.slice(0, 400));
}
