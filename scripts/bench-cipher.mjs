/**
 * Cipher benchmark: the paper's scheme against AES-256-GCM.
 *
 *   node scripts/bench-cipher.mjs
 *
 * Writes results/cipher-*.csv for the report's tables and charts.
 *
 * Measures what actually distinguishes the two schemes:
 *   - encryption and decryption time as the payload grows
 *   - ciphertext expansion (bytes out per byte in), which decides IPFS cost
 *   - key size, which decides whether the key fits in a QR code
 *   - keyspace, which decides whether the cipher is breakable at all
 *
 * Method notes, worth repeating in the report:
 *   - Every point is the median of many runs, not a single timing. Medians
 *     resist the occasional garbage-collection pause that would otherwise
 *     show up as a spurious spike.
 *   - A warm-up pass runs first and is discarded, so the JIT has compiled the
 *     hot paths before anything is recorded.
 */

import fs from "fs";
import path from "path";
import { performance } from "node:perf_hooks";

import * as paper from "../lib/paper-cipher.mjs";
import * as aes from "../lib/aes-cipher.mjs";
import { canonicalise } from "../lib/certificate.mjs";

const OUT = "results";
const REPEATS = 25; // per size, per scheme
const WARMUP = 5;

/** A realistic certificate, padded to a target size with extra transcript rows. */
function certificateOfSize(targetBytes) {
  const base = {
    studentId: "S2024CS042",
    name: "Mansi Davkhar",
    course: "B.Tech Computer Science and Engineering",
    cgpa: "8.7",
    issueDate: "2026-06-15",
    institution: "Example Institute of Technology",
  };
  const subjects = [];
  let i = 0;
  while (canonicalise({ ...base, subjects }).length < targetBytes) {
    subjects.push({ code: `CS${300 + i}`, name: `Subject ${i}`, grade: "A" });
    i++;
  }
  return { ...base, subjects };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function timeIt(fn, repeats) {
  const samples = [];
  for (let i = 0; i < repeats; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return samples;
}

/* ------------------------------------------------------------------ *
 * 1. time and size vs payload size
 * ------------------------------------------------------------------ */

async function benchmarkSizes() {
  const sizes = [256, 512, 1024, 2048, 4096, 8192];
  const rows = [];

  console.log("\nTime and size vs payload");
  console.log("─".repeat(78));
  console.log(
    "bytes".padStart(7),
    "scheme".padEnd(14),
    "enc ms".padStart(9),
    "dec ms".padStart(9),
    "cipher B".padStart(10),
    "expansion".padStart(10)
  );

  for (const size of sizes) {
    const plaintext = canonicalise(certificateOfSize(size));
    const actual = plaintext.length;

    /* --- the paper's cipher --- */
    const pKey = paper.generateKeys(Buffer.byteLength(plaintext));
    await timeIt(() => paper.encrypt(plaintext, pKey), WARMUP);

    const pEnc = await timeIt(() => paper.encrypt(plaintext, pKey), REPEATS);
    const { ciphertext: pCt } = paper.encrypt(plaintext, pKey);
    const pDec = await timeIt(() => paper.decrypt(pCt, pKey), REPEATS);

    /* --- AES-256-GCM --- */
    const aKey = await aes.generateKey();
    await timeIt(() => aes.encrypt(plaintext, aKey), WARMUP);

    const aEnc = await timeIt(() => aes.encrypt(plaintext, aKey), REPEATS);
    const { ciphertext: aCt } = await aes.encrypt(plaintext, aKey);
    const aDec = await timeIt(() => aes.decrypt(aCt, aKey), REPEATS);

    for (const [scheme, enc, dec, ct] of [
      ["paper-v1", pEnc, pDec, pCt],
      ["aes-256-gcm", aEnc, aDec, aCt],
    ]) {
      const row = {
        plaintextBytes: actual,
        scheme,
        encryptMs: +median(enc).toFixed(4),
        decryptMs: +median(dec).toFixed(4),
        ciphertextBytes: Buffer.byteLength(ct),
        expansion: +(Buffer.byteLength(ct) / actual).toFixed(2),
      };
      rows.push(row);
      console.log(
        String(row.plaintextBytes).padStart(7),
        row.scheme.padEnd(14),
        row.encryptMs.toFixed(3).padStart(9),
        row.decryptMs.toFixed(3).padStart(9),
        String(row.ciphertextBytes).padStart(10),
        `${row.expansion}x`.padStart(10)
      );
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * 2. how long does it take to break each one?
 * ------------------------------------------------------------------ */

async function benchmarkBruteForce() {
  console.log("\nBrute-force resistance");
  console.log("─".repeat(78));

  const secret = canonicalise(certificateOfSize(256));

  // The paper's key is two indices, so enumerate them exhaustively.
  const { ciphertext } = paper.encrypt(secret);
  const t0 = performance.now();
  let tried = 0;
  let broken = false;

  outer: for (let t = 1; t <= 400; t++) {
    for (let p = 2; p <= 200; p++) {
      tried++;
      try {
        const guess = paper.generateKeys(Buffer.byteLength(secret), {
          tetraStart: t,
          pentaStart: p,
        });
        if (paper.decrypt(ciphertext, guess) === secret) {
          broken = true;
          break outer;
        }
      } catch {
        /* wrong guess, keep going */
      }
    }
  }
  const elapsed = performance.now() - t0;

  console.log(`paper-v1     keyspace 400 x 199 = ${(400 * 199).toLocaleString()} keys`);
  console.log(
    `             recovered the plaintext after ${tried.toLocaleString()} guesses ` +
      `in ${(elapsed / 1000).toFixed(2)} s — ${broken ? "BROKEN" : "not broken"}`
  );

  // AES-256 for contrast. Not run, obviously: state the arithmetic.
  const aesKeys = 2n ** 256n;
  console.log(`aes-256-gcm  keyspace 2^256 ≈ ${Number(aesKeys).toExponential(2)} keys`);
  console.log(
    `             at 10^12 keys/second that is ~${(
      Number(aesKeys) / 1e12 / 3.15e7 / 1e9
    ).toExponential(2)} billion years`
  );

  return {
    paperKeyspace: 400 * 199,
    paperGuessesNeeded: tried,
    paperSecondsToBreak: +(elapsed / 1000).toFixed(3),
    paperBroken: broken,
    aesKeyspaceBits: 256,
  };
}

/* ------------------------------------------------------------------ *
 * 3. qualitative comparison
 * ------------------------------------------------------------------ */

function propertyTable() {
  return [
    { property: "Key size transmitted to student", paper: "2 small integers (~12 chars)", aes: "43 chars (256-bit, base64url)" },
    { property: "Effective keyspace", paper: "~2^16.6 (two indices)", aes: "2^256" },
    { property: "Authenticated (detects tampering)", paper: "no", aes: "yes, GCM tag" },
    { property: "Same plaintext, same ciphertext?", paper: "yes — deterministic, leaks repeats", aes: "no — fresh IV per message" },
    { property: "Standardised / peer-reviewed", paper: "no", aes: "yes — NIST SP 800-38D" },
    { property: "Hardware accelerated", paper: "no", aes: "yes — AES-NI" },
    { property: "Actually homomorphic", paper: "no, despite the name", aes: "no, and does not claim to be" },
  ];
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

function writeCsv(file, rows) {
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
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  console.log("Cipher benchmark — the paper's scheme vs AES-256-GCM");
  console.log(`node ${process.version}, ${REPEATS} repeats per point, median reported`);

  const sizeRows = await benchmarkSizes();
  const brute = await benchmarkBruteForce();
  const props = propertyTable();

  console.log("\nWriting results");
  writeCsv("cipher-sizes.csv", sizeRows);
  writeCsv("cipher-properties.csv", props);
  writeCsv("cipher-bruteforce.csv", [brute]);

  fs.writeFileSync(
    path.join(OUT, "cipher-summary.json"),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), node: process.version, repeats: REPEATS, sizes: sizeRows, bruteForce: brute, properties: props },
      null,
      2
    )
  );
  console.log(`  wrote ${path.join(OUT, "cipher-summary.json")}`);

  /* A one-line verdict for the report's conclusion. */
  const at1k = sizeRows.filter((r) => r.plaintextBytes > 900 && r.plaintextBytes < 1400);
  const p = at1k.find((r) => r.scheme === "paper-v1");
  const a = at1k.find((r) => r.scheme === "aes-256-gcm");
  if (p && a) {
    console.log("\nAt roughly 1 KB of certificate data:");
    console.log(
      `  AES is ${(p.encryptMs / a.encryptMs).toFixed(1)}x faster to encrypt, ` +
        `produces ${(p.ciphertextBytes / a.ciphertextBytes).toFixed(1)}x less data to store,`
    );
    console.log(
      `  detects tampering, and cannot be brute-forced — while the paper's ` +
        `cipher fell in ${brute.paperSecondsToBreak} s.`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
