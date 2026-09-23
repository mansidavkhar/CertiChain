/**
 * AES-256-GCM, the modern alternative the project benchmarks the paper's
 * cipher against.
 *
 * Written against the Web Crypto API (`globalThis.crypto.subtle`), which is
 * built into browsers and into Node 18+. Same file runs in the dApp and in
 * the benchmark scripts, with no dependency to install.
 *
 * Why GCM rather than plain AES-CBC: GCM is authenticated. Flipping a single
 * bit of the ciphertext makes decryption fail outright instead of returning
 * plausible-looking garbage. The paper's cipher has no such tag, which is one
 * of the concrete differences to write up.
 */

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

const KEY_BITS = 256;
const IV_BYTES = 12; // 96 bits, the size recommended for GCM

/* ------------------------------------------------------------------ *
 * base64url helpers — QR- and URL-safe, no padding
 * ------------------------------------------------------------------ */

export function toBase64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------------------ *
 * key handling
 * ------------------------------------------------------------------ */

/** Generate a fresh, extractable AES-256 key. */
export function generateKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: KEY_BITS }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/** Export to a base64url string, short enough to sit inside a QR code. */
export async function exportKey(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return toBase64Url(new Uint8Array(raw));
}

export function importKey(b64url) {
  return crypto.subtle.importKey(
    "raw",
    fromBase64Url(b64url),
    { name: "AES-GCM", length: KEY_BITS },
    true,
    ["encrypt", "decrypt"]
  );
}

/* ------------------------------------------------------------------ *
 * encrypt / decrypt
 * ------------------------------------------------------------------ */

/**
 * Encrypt a string.
 *
 * A fresh random IV is generated per message and prepended to the ciphertext,
 * so the caller never has to track it. Reusing an IV under the same key breaks
 * GCM badly, which is why it is generated here rather than passed in.
 *
 * @returns {{ ciphertext: string, key: CryptoKey }} ciphertext is base64url
 *          of iv || ciphertext || tag
 */
export async function encrypt(plaintext, key) {
  const k = key ?? (await generateKey());
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, utf8.encode(plaintext))
  );

  const packed = new Uint8Array(iv.length + sealed.length);
  packed.set(iv, 0);
  packed.set(sealed, iv.length);

  return { ciphertext: toBase64Url(packed), key: k };
}

/**
 * Decrypt. Throws if the key is wrong or if a single byte was altered, since
 * the GCM tag is verified as part of decryption.
 */
export async function decrypt(ciphertext, key) {
  const packed = fromBase64Url(ciphertext);
  if (packed.length <= IV_BYTES) throw new Error("ciphertext is too short");

  const iv = packed.slice(0, IV_BYTES);
  const sealed = packed.slice(IV_BYTES);

  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, sealed);
  } catch {
    // Web Crypto throws a bare OperationError; make it readable.
    throw new Error("decryption failed: wrong key or the data was tampered with");
  }
  return fromUtf8.decode(plain);
}
