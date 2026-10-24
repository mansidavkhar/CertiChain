const fs = require("fs");
const path = require("path");
const { ethers, network, artifacts } = require("hardhat");

const TRANSIENT = /Invalid JSON-RPC|Unknown block|coalesce|timeout|ETIMEDOUT|ECONNRESET|429|502|503|rate limit/i;
async function withRetry(label, fn, attempts = 5) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= attempts || !TRANSIENT.test(e.message ?? String(e))) throw e;
      const delay = 1500 * i;
      console.log(`${label}: retry ${i}/${attempts - 1} in ${delay} ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
const waitFor = (tx, label) => withRetry(label, () => tx.wait());

async function deploy(name, args = []) {
  const contract = await ethers.deployContract(name, args);
  await withRetry(`${name} deployment`, () => contract.waitForDeployment());
  const receipt = await waitFor(contract.deploymentTransaction(), `${name} receipt`);
  return { contract, receipt };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`network   ${network.name}\ndeployer  ${deployer.address}\nbalance   ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n && network.name !== "hardhat") throw new Error("Deployer has no funds.");

  const inst = await deploy("InstitutionRegistry");
  const sbt = await deploy("CertificateSBT");
  const registry = await deploy("CertRegistry", [inst.contract.target, sbt.contract.target]);
  const minterTx = await sbt.contract.setMinter(registry.contract.target);
  await waitFor(minterTx, "setMinter receipt");
  const access = await deploy("AccessManager", [registry.contract.target, sbt.contract.target]);
  const batch = await deploy("BatchRegistry", [inst.contract.target]);

  const names = [
    ["InstitutionRegistry", inst],
    ["CertificateSBT", sbt],
    ["CertRegistry", registry],
    ["AccessManager", access],
    ["BatchRegistry", batch],
  ];
  const contracts = {};
  for (const [name, result] of names) {
    const { abi } = await artifacts.readArtifact(name);
    contracts[name] = { address: result.contract.target, abi, deploymentBlock: result.receipt.blockNumber };
    console.log(`${name.padEnd(22)} ${result.contract.target}  gas ${result.receipt.gasUsed}`);
  }
  const record = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    addresses: Object.fromEntries(Object.entries(contracts).map(([name, value]) => [name, value.address])),
    contracts,
    // Kept for scripts written against the original single-contract record.
    address: registry.contract.target,
    abi: contracts.CertRegistry.abi,
  };
  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${network.name}.json`), JSON.stringify(record, null, 2));
  fs.writeFileSync(path.join(__dirname, "..", "frontend", "src", "contract.json"), JSON.stringify(record, null, 2));
  console.log(`saved deployments/${network.name}.json and frontend/src/contract.json`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
