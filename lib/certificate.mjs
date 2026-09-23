/**
 * Certificate payload helpers shared by the dApp, the scripts and the tests.
 *
 * One place decides how a certificate is turned into bytes, how its id is
 * derived and how it is hashed, so the issuing side and the verifying side can
 * never drift apart.
 */

import { keccak256, AbiCoder, toUtf8Bytes } from "ethers";
import * as paper from "./paper-cipher.mjs";
import * as aes from "./aes-cipher.mjs";

export const SCHEMES = { PAPER: "paper-v1", AES: "aes-256-gcm" };

/**
 * Canonical JSON: keys sorted, no incidental whitespace.
 *
 * This matters. The on-chain digest is over the ciphertext bytes, and the
 * ciphertext depends on the exact plaintext bytes. If the issuer serialised
 * the fields in one order and a verifier re-serialised them in another, an
 * honest certificate would look tampered with.
 */
export function canonicalise(certificate) {
  const ordered = {};
  for (const k of Object.keys(certificate).sort()) ordered[k] = certificate[k];
  return JSON.stringify(ordered);
}

/**
 * Derive the certificate id. Must match CertRegistry.computeCertId exactly.
 *
 * The student id never reaches the chain in the clear: only this digest does.
 */
export function computeCertId({ studentId, course, issueDate }) {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "string"],
      [studentId, course, issueDate]
    )
  );
}

/**
 * Digest of the ciphertext exactly as it is stored on IPFS.
 *
 * Hashing the *ciphertext* rather than the plaintext is what lets an employer
 * verify integrity without being able to read the certificate: they fetch the
 * file, hash it, and compare, all without the decryption key.
 */
export function hashCiphertext(ciphertext) {
  return keccak256(toUtf8Bytes(ciphertext));
}

/**
 * Package a certificate for issuance.
 *
 * @param {object} certificate  plain fields (studentId, name, course, cgpa, ...)
 * @param {string} scheme       SCHEMES.PAPER or SCHEMES.AES
 * @returns {Promise<{certId, payload, ciphertext, dataHash, keyMaterial, scheme}>}
 *          `payload` is the JSON object to upload to IPFS; `keyMaterial` is
 *          what goes in the QR code and must never be uploaded.
 */
export async function packageCertificate(certificate, scheme = SCHEMES.AES) {
  const plaintext = canonicalise(certificate);

  let ciphertext;
  let keyMaterial;

  if (scheme === SCHEMES.PAPER) {
    const res = paper.encrypt(plaintext);
    ciphertext = res.ciphertext;
    keyMaterial = paper.exportKey(res.key);
  } else if (scheme === SCHEMES.AES) {
    const res = await aes.encrypt(plaintext);
    ciphertext = res.ciphertext;
    keyMaterial = await aes.exportKey(res.key);
  } else {
    throw new Error(`unknown scheme: ${scheme}`);
  }

  // What lands on IPFS. Note there is no key here, by design.
  const payload = {
    scheme,
    ciphertext,
    issuedBy: certificate.institution ?? null,
    version: 1,
  };

  return {
    certId: computeCertId(certificate),
    payload,
    ciphertext,
    dataHash: hashCiphertext(ciphertext),
    keyMaterial,
    scheme,
  };
}

/**
 * Reverse of packageCertificate: turn a fetched IPFS payload plus the key from
 * the QR code back into the certificate fields.
 */
export async function openCertificate(payload, keyMaterial) {
  if (payload.scheme === SCHEMES.PAPER) {
    const key = paper.importKey(keyMaterial);
    return JSON.parse(paper.decrypt(payload.ciphertext, key));
  }
  if (payload.scheme === SCHEMES.AES) {
    const key = await aes.importKey(keyMaterial);
    return JSON.parse(await aes.decrypt(payload.ciphertext, key));
  }
  throw new Error(`unknown scheme: ${payload.scheme}`);
}
