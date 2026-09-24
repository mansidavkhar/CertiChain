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
import { packageCertificate, SCHEMES } from "../lib/certificate.mjs";

const { ethers, network } = hre;
const OUT = "results";
const isLocal = network.name === "hardhat" || network.name === "localhost";

// Keep testnet runs small: each transaction costs real (test) tokens and
// waits for a real block.
const BATCHES = isLocal ? [10, 20, 30, 40, 50] : [3, 6, 9];

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

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const [issuer, other] = await ethers.getSigners();
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

  const registry = await ethers.deployContract("CertRegistry");
  await registry.waitForDeployment();
  const deployGas = (await registry.deploymentTransaction().wait()).gasUsed;

  const ops = [{ operation: "deploy (once)", gasUsed: deployGas }];

  const c1 = await makeCert(1);
  const r1 = await (await registry.issueCertificate(c1.certId, FAKE_CID, c1.dataHash)).wait();
  ops.push({ operation: "issueCertificate", gasUsed: r1.gasUsed });

  const rAdd = await (await registry.addIssuer(other.address)).wait();
  ops.push({ operation: "addIssuer", gasUsed: rAdd.gasUsed });

  const rRev = await (await registry.revokeCertificate(c1.certId, "benchmark")).wait();
  ops.push({ operation: "revokeCertificate", gasUsed: rRev.gasUsed });

  const rRem = await (await registry.removeIssuer(other.address)).wait();
  ops.push({ operation: "removeIssuer", gasUsed: rRem.gasUsed });

  // The view functions. estimateGas reports what they *would* cost inside a
  // transaction; called externally, as an employer does, they cost nothing.
  const c2 = await makeCert(2);
  await (await registry.issueCertificate(c2.certId, FAKE_CID, c2.dataHash)).wait();
  for (const [label, est] of [
    ["verifyCertificate (view)", await registry.verifyCertificate.estimateGas(c2.certId, c2.dataHash)],
    ["getCertificate (view)", await registry.getCertificate.estimateGas(c2.certId)],
  ]) {
    ops.push({ operation: label, gasUsed: est, note: "free when called off-chain" });
  }

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
    const batchStart = performance.now();

    for (const c of certs) {
      const t0 = performance.now();
      const tx = await registry.issueCertificate(c.certId, FAKE_CID, c.dataHash);
      await tx.wait();
      latencies.push(performance.now() - t0);
    }

    const wall = (performance.now() - batchStart) / 1000;
    const row = {
      transactions: size,
      minLatencyMs: +Math.min(...latencies).toFixed(2),
      avgLatencyMs: +(latencies.reduce((a, b) => a + b, 0) / size).toFixed(2),
      maxLatencyMs: +Math.max(...latencies).toFixed(2),
      throughputTps: +(size / wall).toFixed(2),
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
