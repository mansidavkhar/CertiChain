/**
 * Tests for the off-chain crypto and packaging layer.
 * Run with:  npm run test:lib      (node --test, no framework needed)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import * as paper from "../lib/paper-cipher.mjs";
import * as aes from "../lib/aes-cipher.mjs";
import {
  canonicalise,
  computeCertId,
  hashCiphertext,
  packageCertificate,
  openCertificate,
  SCHEMES,
} from "../lib/certificate.mjs";

const SAMPLE = {
  studentId: "S2024CS042",
  name: "Mansi Davkhar",
  course: "B.Tech CSE",
  cgpa: "8.7",
  issueDate: "2026-06-15",
  institution: "Example Institute of Technology",
};

/* ------------------------------------------------------------------ *
 * the paper's cipher
 * ------------------------------------------------------------------ */

describe("paper cipher (Sultana et al., Algorithms 1 and 4)", () => {
  test("figurate number formulas match the published sequences", () => {
    // OEIS A000292 (tetrahedral) and A000332 (pentatope).
    assert.deepEqual(
      [1, 2, 3, 4, 5].map((n) => Number(paper.tetrahedral(n))),
      [1, 4, 10, 20, 35]
    );
    assert.deepEqual(
      [1, 2, 3, 4, 5].map((n) => Number(paper.pentatope(n))),
      [1, 5, 15, 35, 70]
    );
  });

  test("round-trips plain ASCII", () => {
    const { ciphertext, key } = paper.encrypt("Hello Blockchain");
    assert.equal(paper.decrypt(ciphertext, key), "Hello Blockchain");
  });

  test("round-trips a full certificate JSON", () => {
    const plain = canonicalise(SAMPLE);
    const { ciphertext, key } = paper.encrypt(plain);
    assert.equal(paper.decrypt(ciphertext, key), plain);
  });

  test("round-trips non-ASCII names via UTF-8 bytes", () => {
    const text = "मानसी · José · 学位";
    const { ciphertext, key } = paper.encrypt(text);
    assert.equal(paper.decrypt(ciphertext, key), text);
  });

  test("produces the f<q>r<r> block structure the paper specifies", () => {
    const { ciphertext } = paper.encrypt("AB");
    assert.match(ciphertext, /^f\d+r\d+f\d+r\d+$/);
  });

  test("a serialised key round-trips through export/import", () => {
    const { ciphertext, key } = paper.encrypt("degree certificate");
    const reimported = paper.importKey(paper.exportKey(key));
    assert.equal(paper.decrypt(ciphertext, reimported), "degree certificate");
  });

  test("the wrong key does not yield the plaintext", () => {
    const { ciphertext } = paper.encrypt("SECRET");
    const wrong = paper.generateKeys(6, { tetraStart: 999, pentaStart: 77 });
    // Either it throws (byte out of range) or it decodes to something else.
    let result = null;
    try {
      result = paper.decrypt(ciphertext, wrong);
    } catch {
      /* expected path */
    }
    assert.notEqual(result, "SECRET");
  });

  test("rejects a malformed ciphertext instead of decoding garbage", () => {
    const { key } = paper.encrypt("AB");
    assert.throws(() => paper.decrypt("f1r2XXf3r4", key), /malformed/);
  });

  test("the modulus is never zero or one, which would leak the value", () => {
    // pentaStart >= 2 means P(n) >= 5 for every position.
    for (let i = 0; i < 50; i++) {
      const k = paper.generateKeys(8);
      for (const p of k.Ps) assert.ok(p >= 5n, `pentatope key too small: ${p}`);
    }
  });

  test("demonstrates the weakness written up in the report: tiny keyspace", () => {
    // The whole key is two indices, so an exhaustive search is trivial.
    const secret = "TOPSECRET";
    const { ciphertext } = paper.encrypt(secret);

    let recovered = null;
    outer: for (let t = 1; t <= 400; t++) {
      for (let p = 2; p <= 200; p++) {
        try {
          const guess = paper.generateKeys(secret.length, {
            tetraStart: t,
            pentaStart: p,
          });
          const out = paper.decrypt(ciphertext, guess);
          if (out === secret) {
            recovered = out;
            break outer;
          }
        } catch {
          /* wrong guess */
        }
      }
    }
    assert.equal(recovered, secret, "brute force should succeed, and it does");
  });
});

/* ------------------------------------------------------------------ *
 * AES-256-GCM
 * ------------------------------------------------------------------ */

describe("AES-256-GCM", () => {
  test("round-trips a certificate JSON", async () => {
    const plain = canonicalise(SAMPLE);
    const { ciphertext, key } = await aes.encrypt(plain);
    assert.equal(await aes.decrypt(ciphertext, key), plain);
  });

  test("a key round-trips through base64url export/import", async () => {
    const { ciphertext, key } = await aes.encrypt("hello");
    const reimported = await aes.importKey(await aes.exportKey(key));
    assert.equal(await aes.decrypt(ciphertext, reimported), "hello");
  });

  test("encrypting the same text twice gives different ciphertext", async () => {
    const key = await aes.generateKey();
    const a = await aes.encrypt("same input", key);
    const b = await aes.encrypt("same input", key);
    assert.notEqual(a.ciphertext, b.ciphertext, "IV must be fresh each time");
  });

  test("rejects a wrong key", async () => {
    const { ciphertext } = await aes.encrypt("secret");
    const other = await aes.generateKey();
    await assert.rejects(() => aes.decrypt(ciphertext, other), /decryption failed/);
  });

  test("detects a single flipped character, unlike the paper's cipher", async () => {
    const { ciphertext, key } = await aes.encrypt("Bachelor of Technology");
    const flipped =
      ciphertext.slice(0, 20) +
      (ciphertext[20] === "A" ? "B" : "A") +
      ciphertext.slice(21);
    await assert.rejects(() => aes.decrypt(flipped, key), /tampered/);
  });

  test("the exported key is short enough for a QR code", async () => {
    const k = await aes.exportKey(await aes.generateKey());
    assert.equal(k.length, 43); // 256 bits in unpadded base64url
  });
});

/* ------------------------------------------------------------------ *
 * packaging
 * ------------------------------------------------------------------ */

describe("certificate packaging", () => {
  test("canonicalisation is order independent", () => {
    const a = canonicalise({ b: "2", a: "1" });
    const bb = canonicalise({ a: "1", b: "2" });
    assert.equal(a, bb);
  });

  test("certId is stable across runs and differs per student", () => {
    const id1 = computeCertId(SAMPLE);
    const id2 = computeCertId({ ...SAMPLE, name: "Someone Else" });
    const id3 = computeCertId({ ...SAMPLE, studentId: "S2024CS043" });

    assert.match(id1, /^0x[0-9a-f]{64}$/);
    assert.equal(id1, computeCertId(SAMPLE), "must be deterministic");
    assert.equal(id1, id2, "name is not part of the id");
    assert.notEqual(id1, id3, "a different student must get a different id");
  });

  for (const scheme of [SCHEMES.PAPER, SCHEMES.AES]) {
    test(`end to end with ${scheme}`, async () => {
      const pkg = await packageCertificate(SAMPLE, scheme);

      // What goes to IPFS must not contain the key or any plaintext field.
      const asText = JSON.stringify(pkg.payload);
      assert.ok(!asText.includes("Mansi"), "plaintext leaked into the payload");
      assert.ok(!asText.includes("8.7"), "CGPA leaked into the payload");
      assert.equal(pkg.payload.scheme, scheme);

      // The digest is over the ciphertext, and matches what a verifier computes.
      assert.equal(pkg.dataHash, hashCiphertext(pkg.payload.ciphertext));

      // A verifier with the key recovers the original fields exactly.
      const opened = await openCertificate(pkg.payload, pkg.keyMaterial);
      assert.deepEqual(opened, SAMPLE);
    });

    test(`tampering with the IPFS file changes the digest (${scheme})`, async () => {
      const pkg = await packageCertificate(SAMPLE, scheme);
      const tampered = pkg.payload.ciphertext.replace(/\d/, (d) =>
        d === "9" ? "8" : "9"
      );
      assert.notEqual(
        hashCiphertext(tampered),
        pkg.dataHash,
        "the on-chain check must catch this"
      );
    });
  }

  test("a verifier without the key can still check integrity", async () => {
    const pkg = await packageCertificate(SAMPLE, SCHEMES.AES);
    // Only the payload is needed; no key material involved.
    assert.equal(hashCiphertext(pkg.payload.ciphertext), pkg.dataHash);
  });
});
