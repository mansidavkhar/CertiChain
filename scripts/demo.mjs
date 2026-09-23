/**
 * End-to-end walkthrough of the whole system, on a throwaway chain.
 * This is the demo to run in the viva.
 *
 *   npx hardhat run scripts/demo.mjs
 *
 * It shows, in order:
 *   1. the university is whitelisted as an issuer
 *   2. a certificate is encrypted and "uploaded" (IPFS is stubbed here)
 *   3. only the CID and the ciphertext digest go on-chain
 *   4. an employer verifies it for free, with no wallet
 *   5. someone edits the IPFS file — verification now reports Tampered
 *   6. the university revokes it — verification reports Revoked
 *   7. a random account cannot issue or revoke anything
 */

import hre from "hardhat";
import { packageCertificate, openCertificate, hashCiphertext, SCHEMES } from "../lib/certificate.mjs";

const { ethers } = hre;
const STATUS = ["NotFound", "Valid", "Tampered", "Revoked"];

const line = (t) => console.log(`\n${"─".repeat(64)}\n${t}\n${"─".repeat(64)}`);

// Stand-in for IPFS: a map from fake CID to stored payload.
const ipfs = new Map();
const fakeUpload = (payload) => {
  const cid = "bafkrei" + hashCiphertext(payload.ciphertext).slice(2, 45);
  ipfs.set(cid, structuredClone(payload));
  return cid;
};

async function main() {
  const [university, employer, impostor] = await ethers.getSigners();

  line("1. Deploy and whitelist the issuing university");
  const registry = await ethers.deployContract("CertRegistry");
  await registry.waitForDeployment();
  console.log(`   registry   ${await registry.getAddress()}`);
  console.log(`   university ${university.address} (owner + issuer)`);

  line("2. Encrypt the certificate off-chain");
  const certificate = {
    studentId: "S2024CS042",
    name: "Mansi Davkhar",
    course: "B.Tech Computer Science and Engineering",
    cgpa: "8.7",
    issueDate: "2026-06-15",
    institution: "Example Institute of Technology",
  };

  const pkg = await packageCertificate(certificate, SCHEMES.AES);
  console.log(`   certId     ${pkg.certId}`);
  console.log(`   scheme     ${pkg.scheme}`);
  console.log(`   ciphertext ${pkg.payload.ciphertext.slice(0, 48)}...`);
  console.log(`   key (QR)   ${pkg.keyMaterial}`);
  console.log("   note: the key is given to the student, never uploaded");

  line("3. Upload to IPFS, anchor only the CID + digest on-chain");
  const cid = fakeUpload(pkg.payload);
  console.log(`   cid        ${cid}`);
  console.log(`   dataHash   ${pkg.dataHash}`);

  const tx = await registry.issueCertificate(pkg.certId, cid, pkg.dataHash);
  const receipt = await tx.wait();
  console.log(`   issued in block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);

  line("4. An employer verifies — no wallet, no gas, no key needed");
  const fetched = ipfs.get(cid);
  const recomputed = hashCiphertext(fetched.ciphertext);
  let [status] = await registry
    .connect(employer)
    .verifyCertificate.staticCall(pkg.certId, recomputed);
  console.log(`   recomputed ${recomputed}`);
  console.log(`   status     ${STATUS[Number(status)]}`);

  console.log("\n   With the key from the student's QR code they can read it:");
  const opened = await openCertificate(fetched, pkg.keyMaterial);
  console.log(`   ${JSON.stringify(opened, null, 2).split("\n").join("\n   ")}`);

  line("5. Someone edits the file on IPFS to fake a better CGPA");
  const forged = structuredClone(pkg.payload);
  forged.ciphertext = forged.ciphertext.slice(0, -4) + "AAAA";
  ipfs.set(cid, forged);

  const forgedHash = hashCiphertext(ipfs.get(cid).ciphertext);
  [status] = await registry.verifyCertificate.staticCall(pkg.certId, forgedHash);
  console.log(`   status     ${STATUS[Number(status)]}  <-- caught by the on-chain digest`);

  ipfs.set(cid, pkg.payload); // restore for the next step

  line("6. The university revokes the degree");
  await (await registry.revokeCertificate(pkg.certId, "awarded in error")).wait();
  [status] = await registry.verifyCertificate.staticCall(pkg.certId, pkg.dataHash);
  console.log(`   status     ${STATUS[Number(status)]}`);
  console.log(`   record kept, not deleted: cid still ${(await registry.getCertificate(pkg.certId)).cid.slice(0, 20)}...`);

  line("7. An impostor tries to issue and to revoke");
  const ghost = await packageCertificate(
    { ...certificate, studentId: "FAKE001", cgpa: "10.0" },
    SCHEMES.AES
  );
  for (const [label, call] of [
    ["issue", () => registry.connect(impostor).issueCertificate(ghost.certId, "bafyfake", ghost.dataHash)],
    ["revoke", () => registry.connect(impostor).revokeCertificate(pkg.certId, "malicious")],
  ]) {
    try {
      await call();
      console.log(`   ${label}: SUCCEEDED — this is a bug!`);
    } catch (e) {
      const name = e.message.match(/reverted with custom error '(\w+)/)?.[1] ?? "reverted";
      console.log(`   ${label}: rejected (${name})`);
    }
  }

  line("Done");
  console.log(`   certificates on chain: ${await registry.totalIssued()}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
