#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args.shift() || "help";
const origin = process.env.PHAROS_X402_URL || "https://pharos-x402-agent-buyer.shoupeorg.workers.dev";
const flag = (name, fallback) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : fallback; };
const request = async (path, options = {}) => {
  const response = await fetch(`${origin}${path}`, options); const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`); return body;
};

async function main() {
  if (command === "status") return console.log(JSON.stringify(await request("/api/config"), null, 2));
  if (command === "evidence") return console.log(JSON.stringify(await request("/api/evidence"), null, 2));
  if (command === "view") {
    if (!args[0]) throw new Error("Usage: pharos-x402 view <run-id>");
    return console.log(JSON.stringify(await request(`/api/tasks/${encodeURIComponent(args[0])}`), null, 2));
  }
  if (command === "run") {
    const kind = args.shift(); if (!["success", "budget-limited", "price-cap"].includes(kind)) throw new Error("Run kind must be success, budget-limited, or price-cap");
    const spends = kind !== "price-cap"; const owner = process.env.PHAROS_X402_OWNER_TOKEN;
    if (spends && !owner) throw new Error("Set PHAROS_X402_OWNER_TOKEN for a spending run");
    const runId = flag("run-id", `${kind}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
    const body = { runId, budget: flag("budget", "0.005"), cap: flag("cap", "0.002") };
    return console.log(JSON.stringify(await request(`/api/run/${kind}`, { method: "POST", headers: { "content-type": "application/json", ...(owner ? { authorization: `Bearer ${owner}` } : {}) }, body: JSON.stringify(body) }), null, 2));
  }
  console.log(`Usage:\n  pharos-x402 status\n  pharos-x402 evidence\n  pharos-x402 view <run-id>\n  pharos-x402 run success --budget 0.005 --cap 0.002 --run-id my-run\n  pharos-x402 run budget-limited --budget 0.001 --cap 0.002\n  pharos-x402 run price-cap`);
}
main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });

