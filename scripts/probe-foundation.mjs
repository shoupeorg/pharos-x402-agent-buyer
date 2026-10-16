import { createPublicClient, defineChain, http, toFunctionSelector } from "viem";

const rpcUrl = process.env.PHAROS_RPC_URL || "https://atlantic.dplabs-internal.com";
const documentedToken = "0xE0BE08c77f415F577A1B3A9aD7a1Df1479564ec8";
const chain = defineChain({ id: 688689, name: "Pharos Atlantic Testnet", nativeCurrency: { name: "PHRS", symbol: "PHRS", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } }, testnet: true });
const client = createPublicClient({ chain, transport: http(undefined, { timeout: 30_000 }) });
const code = (await client.getBytecode({ address: documentedToken })) || "0x";
const selectors = Object.fromEntries([
  "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
  "authorizationState(address,bytes32)",
  "DOMAIN_SEPARATOR()",
].map((signature) => [signature, code.toLowerCase().includes(toFunctionSelector(signature).slice(2).toLowerCase())]));
const facilitator = await fetch("https://x402.org/facilitator/supported").then((response) => response.json());
console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  chainId: await client.getChainId(),
  blockNumber: (await client.getBlockNumber()).toString(),
  documentedToken,
  tokenCodeBytes: code.length / 2 - 1,
  selectors,
  publicFacilitator: "https://x402.org/facilitator",
  publicFacilitatorSupportsAtlantic: facilitator.kinds.some((kind) => kind.network === "eip155:688689" && kind.scheme === "exact"),
  conclusion: "Official documented token is not EIP-3009 and the public facilitator does not advertise Atlantic; use the documented self-hosted facilitator path with a test-only EIP-3009 token.",
}, null, 2));
