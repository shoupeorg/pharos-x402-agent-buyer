import fs from "node:fs";
import { createPublicClient, createWalletClient, defineChain, encodeDeployData, formatEther, getAddress, getContractAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const artifact = JSON.parse(fs.readFileSync(new URL("../contracts/PharosX402TestUSD.json", import.meta.url), "utf8"));
const chain = defineChain({ id: 688689, name: "Pharos Atlantic Testnet", nativeCurrency: { name: "PHRS", symbol: "PHRS", decimals: 18 }, rpcUrls: { default: { http: ["https://atlantic.dplabs-internal.com"] } }, testnet: true });
const key = process.env.FACILITATOR_PRIVATE_KEY;
const buyerKey = process.env.BUYER_PRIVATE_KEY;
if (!key || !buyerKey) throw new Error("Secret wrapper did not provide required keys");
const account = privateKeyToAccount(key);
const buyer = privateKeyToAccount(buyerKey);
const expectedFacilitator = "0x5e8cE33c83674dE1D594c325aC3C11E55AcAF124";
const expectedBuyer = "0x03091878d4C83B3c4f803D37bAd11a7d43056b43";
const expectedToken = "0x71d7a8a38A777C5bB84a9aac5c5A727EE7955687";
if (getAddress(account.address) !== getAddress(expectedFacilitator) || getAddress(buyer.address) !== getAddress(expectedBuyer)) throw new Error("Persisted keys do not derive to configured identities");
const transport = http(undefined, { timeout: 30_000, retryCount: 1 });
const publicClient = createPublicClient({ chain, transport });
if (await publicClient.getChainId() !== 688689) throw new Error("Wrong chain ID");
const nonce = await publicClient.getTransactionCount({ address: account.address });
const predicted = getContractAddress({ from: account.address, nonce: BigInt(nonce) });
if (nonce !== 0 || getAddress(predicted) !== getAddress(expectedToken)) throw new Error(`Deployment nonce/address changed; expected nonce 0 and ${expectedToken}`);
const existing = await publicClient.getBytecode({ address: expectedToken });
if (existing && existing !== "0x") throw new Error("Expected token address already contains bytecode; refusing another deployment");
const supply = 10_000_000n; // 10.000000 PXUSD test units
const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [buyer.address, supply] });
const gasEstimate = await publicClient.estimateGas({ account: account.address, data });
const gasPrice = await publicClient.getGasPrice();
const gasLimit = gasEstimate * 120n / 100n;
const ceilingWei = 12_000_000_000_000_000n; // 0.012 PHRS
if (gasLimit * gasPrice > ceilingWei) throw new Error(`Deployment ceiling exceeded: ${formatEther(gasLimit * gasPrice)} PHRS`);
const balance = await publicClient.getBalance({ address: account.address });
if (balance < gasLimit * gasPrice) throw new Error(`Funding required at ${account.address}: balance ${formatEther(balance)} PHRS, estimated ceiling ${formatEther(gasLimit * gasPrice)} PHRS`);
const wallet = createWalletClient({ account, chain, transport });
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [buyer.address, supply], gas: gasLimit });
const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
if (receipt.status !== "success" || getAddress(receipt.contractAddress) !== getAddress(expectedToken)) throw new Error("Token deployment receipt failed or address mismatched");
const [name, symbol, decimals, version, domain, buyerBalance] = await Promise.all([
  publicClient.readContract({ address: expectedToken, abi: artifact.abi, functionName: "name" }),
  publicClient.readContract({ address: expectedToken, abi: artifact.abi, functionName: "symbol" }),
  publicClient.readContract({ address: expectedToken, abi: artifact.abi, functionName: "decimals" }),
  publicClient.readContract({ address: expectedToken, abi: artifact.abi, functionName: "version" }),
  publicClient.readContract({ address: expectedToken, abi: artifact.abi, functionName: "DOMAIN_SEPARATOR" }),
  publicClient.readContract({ address: expectedToken, abi: artifact.abi, functionName: "balanceOf", args: [buyer.address] }),
]);
console.log(JSON.stringify({ chainId: 688689, contract: receipt.contractAddress, transactionHash: hash, receiptStatus: receipt.status, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), gasPriceWei: receipt.effectiveGasPrice.toString(), gasCostWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(), gasCostPHRS: formatEther(receipt.gasUsed * receipt.effectiveGasPrice), token: { name, symbol, decimals, version, domainSeparator: domain, buyerBalanceAtomic: buyerBalance.toString() }, secretsPrinted: false }, null, 2));
