/**
 * Deploy CertRegistry.
 *
 *   npx hardhat run scripts/deploy.js                 # throwaway in-process chain
 *   npx hardhat run scripts/deploy.js --network localhost
 *   npx hardhat run scripts/deploy.js --network sepolia
 *   npx hardhat run scripts/deploy.js --network amoy
 *
 * The deployed address is written to deployments/<network>.json and copied
 * into frontend/src/contract.json, so the dApp never has a hardcoded address.
 */

const fs = require("fs");
const path = require("path");
const { ethers, network, artifacts } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`network   ${network.name}`);
  console.log(`deployer  ${deployer.address}`);
  console.log(`balance   ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n && network.name !== "hardhat") {
    throw new Error(
      "Deployer has no funds. Get testnet ETH from a faucet " +
        "(sepoliafaucet.com for Sepolia, faucet.polygon.technology for Amoy)."
    );
  }

  const registry = await ethers.deployContract("CertRegistry");
  await registry.waitForDeployment();

  const address = await registry.getAddress();
  const tx = registry.deploymentTransaction();
  const receipt = await tx.wait();

  console.log(`\nCertRegistry deployed to ${address}`);
  console.log(`gas used  ${receipt.gasUsed.toString()}`);

  // Persist the address + ABI for the frontend and for later scripts.
  const { abi } = await artifacts.readArtifact("CertRegistry");
  const record = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    address,
    deployer: deployer.address,
    deploymentBlock: receipt.blockNumber,
    deployedAt: new Date().toISOString(),
    abi,
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, `${network.name}.json`),
    JSON.stringify(record, null, 2)
  );

  const frontendDir = path.join(__dirname, "..", "frontend", "src");
  if (fs.existsSync(frontendDir)) {
    fs.writeFileSync(
      path.join(frontendDir, "contract.json"),
      JSON.stringify(record, null, 2)
    );
    console.log("address + ABI copied into frontend/src/contract.json");
  }

  console.log(`saved     deployments/${network.name}.json`);

  if (network.name === "sepolia" || network.name === "amoy") {
    console.log(
      `\nVerify with:\n  npx hardhat verify --network ${network.name} ${address}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
