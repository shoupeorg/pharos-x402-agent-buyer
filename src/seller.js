import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { getAddress, parseSignature } from "viem";
import { MAX_GAS_PER_SETTLEMENT, MAX_GAS_TOTAL, NETWORK } from "./constants.js";
import { publicClient, readPaidResource, tokenAbi, verifySettlementReceipt } from "./chain.js";
import { authorizationId, buildPaymentRequired, makeFacilitator } from "./protocol.js";

const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const responseJson = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...jsonHeaders, ...headers } });
const timestamp = () => new Date().toISOString();

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  return `0x${[...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function assertPayloadMatches(paymentPayload, requirements, resourceUrl, env) {
  const auth = paymentPayload?.payload?.authorization;
  if (paymentPayload.x402Version !== 2 || paymentPayload.accepted?.network !== NETWORK || paymentPayload.accepted?.scheme !== "exact") throw new Error("Payment payload protocol mismatch");
  if (paymentPayload.resource?.url !== resourceUrl) throw new Error("Signed payment resource mismatch");
  if (getAddress(paymentPayload.accepted.asset) !== getAddress(requirements.asset) || getAddress(paymentPayload.accepted.payTo) !== getAddress(requirements.payTo) || paymentPayload.accepted.amount !== requirements.amount) throw new Error("Signed payment requirements changed");
  if (getAddress(auth?.from) !== getAddress(env.BUYER_ADDRESS) || getAddress(auth?.to) !== getAddress(env.MERCHANT_ADDRESS) || auth?.value !== requirements.amount) throw new Error("Authorization parties or amount mismatch");
  return auth;
}

async function estimatedSettlementGas(paymentPayload, env) {
  const auth = paymentPayload.payload.authorization;
  const signature = parseSignature(paymentPayload.payload.signature);
  const client = publicClient();
  return client.estimateContractGas({
    account: env.FACILITATOR_ADDRESS,
    address: env.PAYMENT_TOKEN,
    abi: tokenAbi,
    functionName: "transferWithAuthorization",
    args: [auth.from, auth.to, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, signature.v, signature.r, signature.s],
  });
}

async function recoverUsedAuthorization(row, env) {
  const client = publicClient();
  const payload = JSON.parse(row.payload_json);
  const auth = payload.payload.authorization;
  const used = await client.readContract({ address: env.PAYMENT_TOKEN, abi: tokenAbi, functionName: "authorizationState", args: [auth.from, auth.nonce] });
  if (!used) return null;
  const latest = await client.getBlockNumber();
  const start = BigInt(row.start_block);
  for (let from = start; from <= latest; from += 1000n) {
    const to = from + 999n > latest ? latest : from + 999n;
    const logs = await client.getLogs({ address: env.PAYMENT_TOKEN, event: tokenAbi.find((item) => item.type === "event" && item.name === "AuthorizationUsed"), args: { authorizer: auth.from, nonce: auth.nonce }, fromBlock: from, toBlock: to });
    if (logs.length) return logs[0].transactionHash;
  }
  throw new Error("Authorization is used but its settlement transaction could not be reconciled");
}

export class SellerCoordinator {
  constructor(_state, env) { this.env = env; }
  async fetch(request) {
    try {
      const input = await request.json();
      return responseJson(await this.process(input));
    } catch (error) {
      return responseJson({ error: error.message || "Seller settlement failed" }, 400);
    }
  }

  async process({ endpoint, snapshotBlock, resourceUrl, paymentPayload, requirements }) {
    const env = this.env;
    const auth = assertPayloadMatches(paymentPayload, requirements, resourceUrl, env);
    const authId = authorizationId(paymentPayload);
    const payloadJson = JSON.stringify(paymentPayload);
    const payloadHash = await sha256(payloadJson);
    let row = await env.DB.prepare("SELECT * FROM seller_receipts WHERE auth_id=?").bind(authId).first();
    if (row && row.payload_hash !== payloadHash) throw new Error("Authorization identity collision with different payload");
    if (row?.state === "SETTLED") return { recovered: true, settlement: JSON.parse(row.settlement_json), receipt: JSON.parse(row.receipt_json || "null"), data: JSON.parse(row.response_json), authId };

    const client = publicClient();
    if (!row) {
      const startBlock = (await client.getBlockNumber()).toString();
      await env.DB.prepare("INSERT INTO seller_receipts(auth_id,endpoint,state,payload_hash,payload_json,payer,merchant,amount_atomic,start_block,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .bind(authId, endpoint, "PAYMENT_PENDING", payloadHash, payloadJson, auth.from, auth.to, auth.value, startBlock, timestamp(), timestamp()).run();
      row = await env.DB.prepare("SELECT * FROM seller_receipts WHERE auth_id=?").bind(authId).first();
    }

    let transaction = await recoverUsedAuthorization(row, env);
    let settlement;
    if (transaction) {
      settlement = { success: true, transaction, network: NETWORK, payer: auth.from };
    } else {
      if (BigInt(auth.validBefore) <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("Payment authorization expired before settlement");
      const spentRows = (await env.DB.prepare("SELECT receipt_json FROM seller_receipts WHERE state='SETTLED'").all()).results;
      const actualGas = spentRows.reduce((sum, item) => sum + BigInt(JSON.parse(item.receipt_json || "{}").gasUsed || 0), 0n);
      const estimate = await estimatedSettlementGas(paymentPayload, env);
      if (estimate > MAX_GAS_PER_SETTLEMENT) throw new Error(`Settlement gas estimate ${estimate} exceeds per-transaction ceiling ${MAX_GAS_PER_SETTLEMENT}`);
      if (actualGas + estimate > MAX_GAS_TOTAL) throw new Error("Server-side global settlement gas ceiling reached");
      const facilitator = makeFacilitator(env);
      const verified = await facilitator.verify(paymentPayload, requirements);
      if (!verified.isValid) throw new Error(`Facilitator verification rejected payment: ${verified.invalidReason || "unknown reason"}`);
      settlement = await facilitator.settle(paymentPayload, requirements);
      if (!settlement.success || !settlement.transaction) throw new Error(`Facilitator settlement failed: ${settlement.errorReason || "unknown reason"}`);
      transaction = settlement.transaction;
    }

    const receipt = await verifySettlementReceipt({ txHash: transaction, token: env.PAYMENT_TOKEN, payer: auth.from, merchant: auth.to, amountAtomic: auth.value });
    const data = await readPaidResource(endpoint, snapshotBlock, env);
    await env.DB.prepare("UPDATE seller_receipts SET state='SETTLED', settlement_hash=?, settlement_json=?, receipt_json=?, response_json=?, updated_at=? WHERE auth_id=?")
      .bind(transaction, JSON.stringify(settlement), JSON.stringify(receipt), JSON.stringify(data), timestamp(), authId).run();
    return { recovered: false, settlement, receipt, data, authId };
  }
}

export async function handlePaidRequest(request, env) {
  const url = new URL(request.url);
  const snapshotBlock = url.searchParams.get("block");
  if (!/^\d+$/.test(snapshotBlock || "")) return responseJson({ error: "A numeric pinned block query parameter is required" }, 400);
  const latest = await publicClient().getBlockNumber();
  if (BigInt(snapshotBlock) > latest || latest - BigInt(snapshotBlock) > 1000n) return responseJson({ error: "Pinned block is unavailable or older than 1,000 blocks" }, 400);
  const paymentRequired = buildPaymentRequired({ origin: url.origin, path: url.pathname, snapshotBlock, env });
  const signatureHeader = request.headers.get("PAYMENT-SIGNATURE");
  if (!signatureHeader) {
    return responseJson(paymentRequired, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) });
  }
  let paymentPayload;
  try { paymentPayload = decodePaymentSignatureHeader(signatureHeader); } catch { return responseJson({ error: "Invalid PAYMENT-SIGNATURE header" }, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) }); }
  const requirements = paymentRequired.accepts[0];
  const authId = authorizationId(paymentPayload);
  const stub = env.SELLER.get(env.SELLER.idFromName("seller-global"));
  const processed = await stub.fetch("https://seller.internal/settle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: url.pathname, snapshotBlock, resourceUrl: url.toString(), paymentPayload, requirements }) });
  const result = await processed.json();
  if (!processed.ok) return responseJson({ error: result.error, state: "PENDING_RECONCILIATION", authId }, 502);
  return responseJson({ ...result.data, payment: { authId, recovered: result.recovered } }, 200, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(result.settlement) });
}
