import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const expected = {
  facilitator: [process.env.FACILITATOR_PRIVATE_KEY, "0x5e8cE33c83674dE1D594c325aC3C11E55AcAF124"],
  buyer: [process.env.BUYER_PRIVATE_KEY, "0x03091878d4C83B3c4f803D37bAd11a7d43056b43"],
  merchant: [process.env.MERCHANT_PRIVATE_KEY, "0x3B4a94628dB579353F39f980400DD5EC050D8979"],
};
const checks = Object.fromEntries(Object.entries(expected).map(([name, [secret, address]]) => [name, Boolean(secret && getAddress(privateKeyToAccount(secret).address) === getAddress(address))]));
console.log(JSON.stringify({ checks, ownerTokenPresent: Boolean(process.env.OWNER_TOKEN), secretsPrinted: false }, null, 2));
if (!Object.values(checks).every(Boolean) || !process.env.OWNER_TOKEN) process.exitCode = 1;
