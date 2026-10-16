const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "—").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const fmt = (atomic) => { const padded = String(atomic || "0").padStart(7, "0"); const value = `${padded.slice(0, -6)}.${padded.slice(-6)}`.replace(/\.?0+$/, ""); return `${value || "0"} PXUSD`; };
let evidence = [];
let activeRunId = null;

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function status(message, ok = true) { $("action-status").textContent = message; $("system-status").textContent = ok ? "SYSTEM READY" : "ACTION FAILED"; }
function cards(config) {
  const values = [
    ["NETWORK", `${config.chain.name} / ${config.chain.chainId}`], ["PROTOCOL", `x402 v${config.protocolVersion} / exact / EIP-3009`],
    ["PAYMENT ASSET", `${config.paymentAsset?.symbol || "—"} · ${config.paymentAsset?.address || "NOT CONFIGURED"}`], ["LATEST BLOCK", config.chain.latestBlock],
    ["BUYER", config.buyer], ["MERCHANT", config.merchant], ["FACILITATOR", config.facilitator], ["SELLER DISCLOSURE", config.disclosure],
  ];
  $("foundation").innerHTML = values.map(([key, value]) => `<div class="source-card"><b>${esc(key)}</b><span>${esc(value)}</span></div>`).join("");
}
function stateClass(value) { return ["COMPLETED", "DATA_RECEIVED", "SETTLED"].includes(value) ? "ok" : ["FAILED", "PENDING_RECONCILIATION"].includes(value) ? "bad" : "warn"; }
function render(snapshot) {
  const { task, intents, events } = snapshot;
  activeRunId = task.id;
  $("run-id").textContent = task.id; $("decision").textContent = task.status;
  $("spend").textContent = `${fmt(task.confirmed_atomic)} / ${fmt(task.reserved_atomic)}`;
  $("remaining").textContent = fmt((BigInt(task.budget_atomic) - BigInt(task.confirmed_atomic) - BigInt(task.reserved_atomic)).toString());
  $("intents").innerHTML = intents.length ? intents.map((item) => `<article class="intent-card"><h3>${esc(item.endpoint)}</h3><p><b>WHY:</b> ${esc(item.decision_reason)}<br><b>QUOTE:</b> ${esc(fmt(item.amount_atomic))} · <b>ATTEMPTS:</b> ${esc(item.attempt_count)}<br><b>AUTH ID:</b> ${esc(item.auth_id || "not created — refused before signing")}</p><span class="tag ${stateClass(item.state)}">${esc(item.state)}</span></article>`).join("") : '<div class="empty">NO INTENTS</div>';
  $("receipts").innerHTML = intents.some((item) => item.receipt) ? intents.filter((item) => item.receipt).map((item) => `<article class="receipt-card"><h3>${esc(item.endpoint)}</h3><p><b>TX:</b> <a href="https://atlantic.pharosscan.xyz/tx/${esc(item.settlement_hash)}" target="_blank" rel="noopener noreferrer">${esc(item.settlement_hash)} ↗</a><br><b>RECEIPT:</b> ${esc(item.receipt.status)} · block ${esc(item.receipt.blockNumber)} · gas ${esc(item.receipt.gasUsed)}<br><b>TRANSFER:</b> ${esc(item.receipt.transfer.from)} → ${esc(item.receipt.transfer.to)} · ${esc(fmt(item.receipt.transfer.value))}</p><span class="tag ok">VERIFIED</span></article>`).join("") : '<div class="empty">NO SETTLEMENT — REFUSAL OCCURRED BEFORE SIGNING</div>';
  $("report").textContent = task.report ? JSON.stringify(task.report, null, 2) : `No completed report. Final state: ${task.status}`;
  $("events").innerHTML = events.length ? events.map((item) => `<tr><td>${esc(item.id)}</td><td>${esc(item.created_at)}</td><td>${esc(item.intent_id)}</td><td><span class="tag ${stateClass(item.type)}">${esc(item.type)}</span></td><td><pre>${esc(JSON.stringify(item.detail, null, 2))}</pre></td></tr>`).join("") : '<tr><td colspan="5">NO EVENTS</td></tr>';
  status(`LOADED ${task.id}`);
}
async function loadEvidence() { const data = await api("/api/evidence"); evidence = data.runs; return evidence; }
async function viewKind(kind) {
  await loadEvidence(); const row = evidence.find((item) => item.kind === kind);
  if (!row) throw new Error(`No recorded ${kind} evidence is available yet`);
  render(await api(`/api/tasks/${encodeURIComponent(row.id)}`));
}
async function run(kind) {
  const spending = kind !== "price-cap"; const owner = $("owner-token").value;
  if (spending && !owner) throw new Error("Enter the owner token before using a spending button");
  const id = `${kind}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`; activeRunId = id;
  const buttons = [...document.querySelectorAll("button")]; buttons.forEach((button) => { button.disabled = true; }); status("RUNNING — DO NOT RESUBMIT");
  try {
    const snapshot = await api(`/api/run/${kind}`, { method: "POST", headers: { "content-type": "application/json", ...(spending ? { authorization: `Bearer ${owner}` } : {}) }, body: JSON.stringify({ runId: id, budget: $("budget").value, cap: $("cap").value }) });
    render(snapshot); await loadEvidence();
  } finally { buttons.forEach((button) => { button.disabled = false; }); }
}
async function init() {
  try { cards(await api("/api/config")); await loadEvidence(); $("connection").textContent = "CONNECTED"; status("READY — SELECT EVIDENCE OR RUN"); }
  catch (error) { $("connection").textContent = "ERROR"; status(error.message, false); }
}
$("run-success").addEventListener("click", () => run("success").catch((error) => status(error.message, false)));
$("run-budget").addEventListener("click", () => run("budget-limited").catch((error) => status(error.message, false)));
$("test-cap").addEventListener("click", () => run("price-cap").catch((error) => status(error.message, false)));
$("view-success").addEventListener("click", () => viewKind("SUCCESS").catch((error) => status(error.message, false)));
$("view-budget").addEventListener("click", () => viewKind("BUDGET_STOP").catch((error) => status(error.message, false)));
$("view-retry").addEventListener("click", () => viewKind("SUCCESS").catch((error) => status(error.message, false)));
$("refresh").addEventListener("click", () => activeRunId ? api(`/api/tasks/${encodeURIComponent(activeRunId)}`).then(render).catch((error) => status(error.message, false)) : init());
init();
