import { buildBody, streamChat } from "./probe.mjs";
const body = buildBody(process.argv[2] || "用中文写一句话：春天来了。", {});
let i = 0;
const r = await streamChat(body, (e) => {
  i++;
  console.log(`\n=== #${i} ${e.event} (data ${String(e.data).length}ch)`);
  console.log(String(e.data).slice(0, 1100));
});
console.log("\nstatus", r.status, "events", r.events);
