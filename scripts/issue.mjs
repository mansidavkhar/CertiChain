/**
 * Issue a real certificate: encrypt, pin to IPFS, anchor on-chain, print a
 * verification link and QR code.
 *
 *   npx hardhat run scripts/issue.mjs --network amoy
 *
 * Fields are read from a JSON file so nothing sensitive ends up in shell
 * history. Copy samples/certificate.sample.json and edit it:
 *
 *   CERT_FILE=samples/my-cert.json npx hardhat run scripts/issue.mjs --network amoy
 *
 * Requires PINATA_JWT and PRIVATE_KEY in .env.
 */

import fs from "fs";
import os from "os";
import path from "path";
import hre from "hardhat";
import QRCode from "qrcode";

import { packageCertificate, SCHEMES } from "../lib/certificate.mjs";
import { pinJSON, gatewayUrl } from "../lib/ipfs.mjs";

const { ethers, network } = hre;

const CERT_FILE = process.env.CERT_FILE || "samples/certificate.sample.json";
const SCHEME = process.env.SCHEME || SCHEMES.AES;

/**
 * Find this machine's address on the local network.
 *
 * The QR code is meant to be scanned with a phone, and "localhost" in a QR
 * code means the *phone*, which is running nothing — you get
 * ERR_CONNECTION_REFUSED. The link has to carry an address the phone can
 * actually reach, so default to the LAN IP rather than localhost.
 *
 * Remember to start Vite with `npm run dev -- --host`, or it listens only on
 * localhost and the phone still cannot connect.
 */
function lanAddress() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}

const lan = lanAddress();
const APP_URL = process.env.APP_URL || `http://${lan ?? "localhost"}:5173`;

function loadDeployment() {
  const file = path.join("deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No deployment found for "${network.name}".\n` +
        `Deploy first:  npx hardhat run scripts/deploy.js --network ${network.name}`
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
  /* ---- 1. inputs -------------------------------------------------- */

  if (!fs.existsSync(CERT_FILE)) {
    throw new Error(`Certificate file not found: ${CERT_FILE}`);
  }
  const certificate = JSON.parse(fs.readFileSync(CERT_FILE, "utf8"));

  for (const field of ["studentId", "course", "issueDate"]) {
    if (!certificate[field]) {
      throw new Error(`"${field}" is required — it is part of the certId`);
    }
  }

  const jwt = process.env.PINATA_JWT;
  const deployment = loadDeployment();
  const [signer] = await ethers.getSigners();

  console.log(`network   ${network.name} (chainId ${deployment.chainId})`);
  console.log(`registry  ${deployment.address}`);
  console.log(`issuer    ${signer.address}`);
  console.log(`scheme    ${SCHEME}\n`);

  const registry = await ethers.getContractAt(
    "CertRegistry",
    deployment.addresses?.CertRegistry ?? deployment.address
  );
  const institutions = await ethers.getContractAt(
    "InstitutionRegistry",
    deployment.addresses?.InstitutionRegistry
  );

  // Fail early with a clear message rather than deep inside a revert.
  if (!(await institutions.isApproved(signer.address))) {
    throw new Error(
      `${signer.address} is not a whitelisted issuer.\n` +
        `The contract owner must call addInstitution() for this address first.`
    );
  }

  /* ---- 2. encrypt ------------------------------------------------- */

  const pkg = await packageCertificate(certificate, SCHEME);
  console.log(`certId    ${pkg.certId}`);

  const [existing] = await registry.verifyCertificate(pkg.certId, pkg.dataHash);
  if (existing !== 0n) {
    throw new Error(
      `A certificate with this id already exists on chain.\n` +
        `certId is derived from studentId + course + issueDate, so change ` +
        `one of those, or revoke the old one first.`
    );
  }

  /* ---- 3. pin to IPFS --------------------------------------------- */

  console.log("pinning to IPFS...");
  const cid = await pinJSON(
    pkg.payload,
    jwt,
    `cert-${certificate.studentId}-${certificate.issueDate}`
  );
  console.log(`cid       ${cid}`);
  console.log(`url       ${gatewayUrl(cid)}`);
  console.log(`dataHash  ${pkg.dataHash}\n`);

  /* ---- 4. anchor on chain ----------------------------------------- */

  console.log("submitting transaction...");
  const tx = await registry.issueCertificate(
    pkg.certId, cid, pkg.dataHash, certificate.studentWallet ?? ethers.ZeroAddress
  );
  console.log(`tx        ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`mined in block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);

  if (network.name === "amoy") {
    console.log(`explorer  https://amoy.polygonscan.com/tx/${tx.hash}`);
  } else if (network.name === "sepolia") {
    console.log(`explorer  https://sepolia.etherscan.io/tx/${tx.hash}`);
  }

  /* ---- 5. the student's verification link + QR --------------------- */

  const params = new URLSearchParams({
    id: pkg.certId,
    cid,
    key: typeof pkg.keyMaterial === "string"
      ? pkg.keyMaterial
      : JSON.stringify(pkg.keyMaterial),
    scheme: SCHEME,
  });
  const link = `${APP_URL}/#/verify?${params}`;

  const outDir = "issued";
  fs.mkdirSync(outDir, { recursive: true });
  const stem = `${certificate.studentId}-${certificate.issueDate}`;

  await QRCode.toFile(path.join(outDir, `${stem}.png`), link, {
    width: 600,
    margin: 2,
  });
  fs.writeFileSync(
    path.join(outDir, `${stem}.json`),
    JSON.stringify(
      {
        certId: pkg.certId,
        cid,
        dataHash: pkg.dataHash,
        scheme: SCHEME,
        key: pkg.keyMaterial,
        link,
        txHash: tx.hash,
        network: network.name,
        issuedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  console.log(`\nQR code   ${outDir}/${stem}.png`);
  console.log(`record    ${outDir}/${stem}.json`);
  console.log(`\nGive the student the QR code. It carries the decryption key,`);
  console.log(`so treat it as confidential — anyone holding it can read the`);
  console.log(`certificate (though not forge one).`);

  console.log(`\nVerification link:\n${link}`);
  if (lan && !process.env.APP_URL) {
    console.log(
      `\nThe link points at ${lan}, this machine's address on your network,` +
        `\nso a phone on the same Wi-Fi can open it. For that to work the dev` +
        `\nserver must be listening on all interfaces:` +
        `\n    cd frontend && npm run dev -- --host` +
        `\nOn this machine, http://localhost:5173 works too.`
    );
  }

  // Also draw it in the terminal, handy when demonstrating live.
  console.log(`\n${await QRCode.toString(link, { type: "terminal", small: true })}`);
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  process.exitCode = 1;
});
