import { spawnSync } from "node:child_process";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const expected = {
  FACILITATOR_PRIVATE_KEY: "0x5e8cE33c83674dE1D594c325aC3C11E55AcAF124",
  BUYER_PRIVATE_KEY: "0x03091878d4C83B3c4f803D37bAd11a7d43056b43",
  MERCHANT_PRIVATE_KEY: "0x3B4a94628dB579353F39f980400DD5EC050D8979",
};
for (const [name, address] of Object.entries(expected)) {
  if (!process.env[name] || getAddress(privateKeyToAccount(process.env[name]).address) !== getAddress(address)) throw new Error(`${name} does not derive to configured address`);
}
if (!process.env.OWNER_TOKEN || process.env.OWNER_TOKEN.length < 32) throw new Error("OWNER_TOKEN missing or too short");
for (const name of [...Object.keys(expected), "OWNER_TOKEN"]) {
  const result = spawnSync("npx.cmd", ["wrangler", "secret", "put", name], { input: process.env[name], encoding: "utf8", stdio: ["pipe", "inherit", "inherit"], shell: true });
  if (result.status !== 0) throw new Error(`Cloudflare secret upload failed for ${name}`);
}
console.log(JSON.stringify({ uploaded: [...Object.keys(expected), "OWNER_TOKEN"], identitiesVerifiedBeforeUpload: true, secretsPrinted: false }, null, 2));
