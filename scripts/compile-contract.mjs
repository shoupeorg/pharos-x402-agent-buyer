import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(root, "contracts", "PharosX402TestUSD.sol");
const source = fs.readFileSync(sourcePath, "utf8");
const input = {
  language: "Solidity",
  sources: { "PharosX402TestUSD.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors || []).filter((entry) => entry.severity === "error");
if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));
const contract = output.contracts["PharosX402TestUSD.sol"].PharosX402TestUSD;
const artifact = {
  contractName: "PharosX402TestUSD",
  compiler: solc.version(),
  abi: contract.abi,
  bytecode: `0x${contract.evm.bytecode.object}`,
  deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
};
const artifactPath = path.join(root, "contracts", "PharosX402TestUSD.json");
fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({ artifactPath, compiler: artifact.compiler, bytecodeBytes: artifact.bytecode.length / 2 - 1, deployedBytes: artifact.deployedBytecode.length / 2 - 1 }, null, 2));
