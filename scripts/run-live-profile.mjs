const [kind, runId] = process.argv.slice(2);
if (!new Set(["success", "budget-limited", "price-cap"]).has(kind) || !runId) {
  throw new Error("Usage: run-live-profile.mjs <success|budget-limited|price-cap> <run-id>");
}

const origin = process.env.PUBLIC_ORIGIN || "https://pharos-x402-agent-buyer.shoupeorg.workers.dev";
const spends = kind !== "price-cap";
if (spends && !process.env.OWNER_TOKEN) throw new Error("OWNER_TOKEN is unavailable");

const profiles = {
  success: { budget: "0.005", cap: "0.002" },
  "budget-limited": { budget: "0.001", cap: "0.002" },
  "price-cap": { budget: "0.005", cap: "0.000999" },
};

const response = await fetch(`${origin}/api/run/${kind}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(spends ? { authorization: `Bearer ${process.env.OWNER_TOKEN}` } : {}),
  },
  body: JSON.stringify({ runId, ...profiles[kind] }),
});
const result = await response.json();
if (!response.ok) throw new Error(`Live profile failed with HTTP ${response.status}: ${result.error || "unknown error"}`);
console.log(JSON.stringify(result, null, 2));
