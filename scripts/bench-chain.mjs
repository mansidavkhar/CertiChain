/**
 * On-chain evaluation: gas, cost, latency and throughput.
 *
 *   npx hardhat run scripts/bench-chain.mjs                 # local, free, fast
 *   npx hardhat run scripts/bench-chain.mjs --network amoy  # real testnet
 *
 * Reproduces the measurements in Tables 5-8 and Figures 9-11 of the paper,
 * and writes results/chain-*.csv.
 *
 * ─── Read this before quoting the latency numbers ───────────────────────
 * On the local Hardhat network every transaction is mined the instant it is
 * sent. Latency there measures how fast the *node software* responds, not
 * how fast a blockchain reaches consensus, so local figures look
 * implausibly good. The paper has the same issue: it reports latencies in
 * fractions of a millisecond, which is not achievable on a real network
 * where blocks arrive every couple of seconds.
 *
 * Run this on Amoy for the numbers that go in the report, and use the local
 * run only to show the gas costs (which are identical either way, because
 * gas is determined by the bytecode, not by the network).
 * ────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import hre from "hardhat";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { packageCertificate, SCHEMES } from "../lib/certificate.mjs";

const { ethers, network } = hre;
const OUT = "results";
const isLocal = network.name === "hardhat" || network.name === "localhost";

// Keep testnet runs small: each transaction costs real (test) tokens and
// waits for a real block.
const BATCHES = isLocal ? [10, 20, 30, 40, 50] : [3, 6, 9];

/**
 * Public RPC endpoints drop requests under load, and a run that dies halfway
 * wastes real testnet tokens. These are the failures worth retrying:
 *
 *   "Invalid JSON-RPC response"  the endpoint returned an empty or truncated
 *                                body, usually while rate-limiting
 *   "Unknown block"              the transaction was sent, then a different
 *                                server behind the same load balancer handled
 *                                the receipt request and had not synced that
 *                                block yet
 *   429 / 503 / timeouts         ordinary overload
 *
 * None of these mean the transaction failed, so waiting and asking again is
 * the correct response rather than aborting.
 */
const TRANSIENT =
  /Invalid JSON-RPC response|Unknown block|could not coalesce|timeout|ETIMEDOUT|ECONNRESET|socket hang up|429|503|502|rate limit/i;

async function withRetry(label, fn, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e.message ?? String(e);
      if (i >= attempts || !TRANSIENT.test(msg)) throw e;
      const wait = 1500 * i;
      console.log(
        `   ${label}: RPC hiccup (${msg.slice(0, 48).trim()}…) — retry ${i}/${attempts - 1} in ${wait} ms`
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** Wait for a receipt, tolerating an endpoint that has not caught up yet. */
const waitFor = (tx, label = "receipt") => withRetry(label, () => tx.wait());

const csv = (file, rows) => {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const body = rows.map((r) =>
    headers.map((h) => {
      const v = String(r[h] ?? "");
      return v.includes(",") ? `"${v}"` : v;
    }).join(",")
  );
  fs.writeFileSync(path.join(OUT, file), [headers.join(","), ...body].join("\n") + "\n");
  console.log(`  wrote ${path.join(OUT, file)}`);
};

/** A distinct certificate per iteration, so no certId ever collides. */
async function makeCert(n) {
  return packageCertificate(
    {
      studentId: `BENCH${String(n).padStart(5, "0")}`,
      name: `Student ${n}`,
      course: "B.Tech Computer Science and Engineering",
      cgpa: "8.5",
      issueDate: "2026-06-15",
      institution: "Example Institute of Technology",
    },
    SCHEMES.AES
  );
}

const FAKE_CID = "bafkreievb2nwrex2lhhaoosmezv3j3dc7y2t7b24hx57ynwbjblqzxa66a";

function makeBatchTree(size, seed) {
  const values = Array.from({ length: size }, (_, index) => [
    ethers.keccak256(ethers.toUtf8Bytes(`batch-${seed}-cert-${index}`)),
    ethers.keccak256(ethers.toUtf8Bytes(`batch-${seed}-data-${index}`)),
  ]);
  return StandardMerkleTree.of(values, ["bytes32", "bytes32"]);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const [issuer] = await ethers.getSigners();

  /**
   * A throwaway address to add and remove as an issuer.
   *
   * On a local chain Hardhat hands you twenty funded signers, but on a real
   * network there is exactly one — the single PRIVATE_KEY from .env — so
   * asking for a second signer gives undefined. addIssuer only writes an
   * address into a mapping and never needs that account to sign anything,
   * so a freshly generated address measures the same gas.
   */
  const scratch = ethers.Wallet.createRandom().address;

  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? ethers.parseUnits("30", "gwei");
  const symbol = network.name === "amoy" ? "POL" : "ETH";

  console.log(`network    ${network.name}`);
  console.log(`issuer     ${issuer.address}`);
  console.log(`gas price  ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
  if (isLocal) {
    console.log("\nNOTE: local network — gas figures are real, latency figures are not.");
  }

  /* ---------------------------------------------------------------- *
   * 1. gas per operation  (the paper's Table 5)
   * ---------------------------------------------------------------- */

  console.log("\nGas per operation");
  console.log("─".repeat(72));

  const deployed = [];
  async function deployMeasured(name, args = []) {
    const c = await ethers.deployContract(name, args);
    await c.waitForDeployment();
    const receipt = await waitFor(c.deploymentTransaction(), `deploy ${name}`);
    deployed.push({ operation: `deploy ${name}`, gasUsed: receipt.gasUsed });
    return c;
  }
  const institutions = await deployMeasured("InstitutionRegistry");
  const sbt = await deployMeasured("CertificateSBT");
  const registry = await deployMeasured("CertRegistry", [institutions.target, sbt.target]);
  await waitFor(await sbt.setMinter(registry.target), "setMinter");
  const access = await deployMeasured("AccessManager", [registry.target, sbt.target]);
  const batch = await deployMeasured("BatchRegistry", [institutions.target]);
  const ops = [...deployed];

  // Fresh benchmark deployments start with no approved institutions.
  // Approve the signer before measuring certificate operations.
  const rApprove = await withRetry("approve benchmark issuer", async () =>
    waitFor(await institutions.addInstitution(issuer.address, "Benchmark issuer"))
  );
  ops.push({ operation: "addInstitution (issuer setup)", gasUsed: rApprove.gasUsed });

  const c1 = await makeCert(1);
  const r1 = await withRetry("issue", async () =>
    waitFor(await registry.issueCertificate(c1.certId, FAKE_CID, c1.dataHash, issuer.address))
  );
  ops.push({ operation: "issueCertificate", gasUsed: r1.gasUsed });

  const rAdd = await withRetry("addInstitution", async () =>
    waitFor(await institutions.addInstitution(scratch, "Benchmark"))
  );
  ops.push({ operation: "addInstitution", gasUsed: rAdd.gasUsed });

  const rRev = await withRetry("revoke", async () =>
    waitFor(await registry.revokeCertificate(c1.certId, "benchmark"))
  );
  ops.push({ operation: "revokeCertificate", gasUsed: rRev.gasUsed });

  const rRem = await withRetry("removeInstitution", async () =>
    waitFor(await institutions.removeInstitution(scratch))
  );
  ops.push({ operation: "removeInstitution", gasUsed: rRem.gasUsed });

  // The view functions. estimateGas reports what they *would* cost inside a
  // transaction; called externally, as an employer does, they cost nothing.
  const c2 = await makeCert(2);
  await withRetry("issue2", async () =>
    waitFor(await registry.issueCertificate(c2.certId, FAKE_CID, c2.dataHash, issuer.address))
  );
  for (const [label, est] of [
    ["verifyCertificate (view)", await registry.verifyCertificate.estimateGas(c2.certId, c2.dataHash)],
    ["getCertificate (view)", await registry.getCertificate.estimateGas(c2.certId)],
  ]) {
    ops.push({ operation: label, gasUsed: est, note: "free when called off-chain" });
  }

  /*
   * Batch measurements use fake ciphertext digests and no IPFS. Building the
   * tree is intentionally off-chain; only one root anchor is sent on-chain
   * for each N. This isolates the chain cost of batch registration.
   */
  const batchSizes = [10, 50, 100, 500];
  const batchRows = [];
  let firstBatch = null;
  for (const size of batchSizes) {
    const tree = makeBatchTree(size, size);
    const anchorReceipt = await withRetry(`anchorBatch N=${size}`, async () =>
      waitFor(await batch.anchorBatch(tree.root, size, `benchmark-${size}`))
    );
    if (!firstBatch) firstBatch = { tree, size };
    const anchorGas = BigInt(anchorReceipt.gasUsed);
    const singleGasPerCertificate = BigInt(r1.gasUsed);
    batchRows.push({
      certificates: size,
      singleGasPerCertificate: Number(singleGasPerCertificate),
      singleTotalGas: Number(singleGasPerCertificate * BigInt(size)),
      batchAnchorGas: Number(anchorGas),
      batchGasPerCertificate: Number(anchorGas / BigInt(size)),
      batchGasPerCertificateExact: Number(anchorGas) / size,
      savingsPercent: +(
        (1 - Number(anchorGas) / Number(singleGasPerCertificate * BigInt(size))) * 100
      ).toFixed(2),
      currency: symbol,
    });
    ops.push({ operation: `anchorBatch (${size})`, gasUsed: anchorGas });
  }

  const batchRevokeReceipt = await withRetry("revokeInBatch", async () =>
    waitFor(await batch.revokeInBatch(
      firstBatch.tree.root,
      firstBatch.tree.at(0)[0],
      "benchmark"
    ))
  );
  ops.push({ operation: "revokeInBatch", gasUsed: batchRevokeReceipt.gasUsed });

  const opRows = ops.map((o) => ({
    operation: o.operation,
    gasUsed: Number(o.gasUsed),
    costNative: +ethers.formatEther(BigInt(o.gasUsed) * gasPrice),
    currency: symbol,
    note: o.note ?? "",
  }));

  for (const r of opRows) {
    console.log(
      r.operation.padEnd(26),
      String(r.gasUsed).padStart(9),
      `${r.costNative.toFixed(8)} ${symbol}`.padStart(22),
      r.note
    );
  }

  /* ---------------------------------------------------------------- *
   * 2. cumulative cost vs number of certificates (Table 7, Figure 9)
   * ---------------------------------------------------------------- */

  const perIssue = BigInt(r1.gasUsed);
  const costRows = [1, 5, 10, 25, 50, 100].map((n) => ({
    certificates: n,
    totalGas: Number(perIssue) * n,
    totalCost: +ethers.formatEther(perIssue * BigInt(n) * gasPrice),
    currency: symbol,
  }));

  console.log("\nCumulative issuance cost");
  console.log("─".repeat(72));
  for (const r of costRows) {
    console.log(
      String(r.certificates).padStart(5),
      "certs",
      String(r.totalGas).padStart(10),
      "gas",
      `${r.totalCost.toFixed(6)} ${symbol}`.padStart(20)
    );
  }

  /* ---------------------------------------------------------------- *
   * 3. latency and throughput (Tables 6 & 8, Figures 10 & 11)
   * ---------------------------------------------------------------- */

  console.log("\nLatency and throughput");
  console.log("─".repeat(72));
  console.log(
    "txs".padStart(5),
    "min ms".padStart(9),
    "avg ms".padStart(9),
    "max ms".padStart(9),
    "tps".padStart(8),
    "encrypt ms".padStart(11)
  );

  const perfRows = [];
  let counter = 1000;

  for (const size of BATCHES) {
    // Prepare everything up front so encryption time is measured separately
    // and never counted as chain latency.
    const encStart = performance.now();
    const certs = [];
    for (let i = 0; i < size; i++) certs.push(await makeCert(counter++));
    const encryptMs = performance.now() - encStart;

    const latencies = [];
    let failed = 0;
    const batchStart = performance.now();

    for (const c of certs) {
      const t0 = performance.now();
      try {
        const tx = await registry.issueCertificate(c.certId, FAKE_CID, c.dataHash, issuer.address);
        await waitFor(tx, "latency sample");
        latencies.push(performance.now() - t0);
      } catch (e) {
        // One bad sample should not throw away the whole batch. Record it and
        // report how many succeeded, so the numbers stay honest.
        failed++;
        console.log(`   sample dropped: ${(e.message ?? e).toString().slice(0, 70)}`);
      }
    }

    if (latencies.length === 0) {
      console.log(`   all ${size} transactions failed — skipping this batch`);
      continue;
    }

    const wall = (performance.now() - batchStart) / 1000;
    const row = {
      transactions: latencies.length,
      minLatencyMs: +Math.min(...latencies).toFixed(2),
      avgLatencyMs: +(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2),
      maxLatencyMs: +Math.max(...latencies).toFixed(2),
      throughputTps: +(latencies.length / wall).toFixed(2),
      failedTransactions: failed,
      encryptionMsTotal: +encryptMs.toFixed(2),
      network: network.name,
    };
    perfRows.push(row);

    console.log(
      String(row.transactions).padStart(5),
      row.minLatencyMs.toFixed(2).padStart(9),
      row.avgLatencyMs.toFixed(2).padStart(9),
      row.maxLatencyMs.toFixed(2).padStart(9),
      row.throughputTps.toFixed(2).padStart(8),
      row.encryptionMsTotal.toFixed(2).padStart(11)
    );
  }

  /* ---------------------------------------------------------------- *
   * write out
   * ---------------------------------------------------------------- */

  console.log("\nWriting results");
  const suffix = isLocal ? "local" : network.name;
  csv(`chain-gas-${suffix}.csv`, opRows);
  csv(`chain-cost-${suffix}.csv`, costRows);
  csv(`chain-performance-${suffix}.csv`, perfRows);
  csv(`chain-batch-${suffix}.csv`, batchRows);

  fs.writeFileSync(
    path.join(OUT, `chain-summary-${suffix}.json`),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        network: network.name,
        localNetworkCaveat: isLocal
          ? "Latency and throughput are not meaningful on a local auto-mining node; gas figures are."
          : null,
        gasPriceGwei: +ethers.formatUnits(gasPrice, "gwei"),
        currency: symbol,
        operations: opRows,
        cumulativeCost: costRows,
        performance: perfRows,
        batchComparison: batchRows,
      },
      null,
      2
    )
  );
  console.log(`  wrote ${path.join(OUT, `chain-summary-${suffix}.json`)}`);

  console.log(`\nTotal certificates issued during this run: ${await registry.totalIssued()}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
