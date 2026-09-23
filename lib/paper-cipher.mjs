/**
 * The cipher from Sultana et al. (2023), Algorithms 1 and 4.
 *
 * Faithful reimplementation, kept deliberately close to the paper's notation
 * so it can be compared line by line in the report. Read SECURITY NOTES at the
 * bottom before claiming anything about how strong this is: it is implemented
 * here to reproduce the paper, not because it is a good cipher.
 *
 * Encryption, per character j of the plaintext:
 *     BO_j = ASCII(C_j) XOR Ts_j            (Ts = tetrahedral key)
 *     DH_j = BO_j  /  Ps_j                  (integer division, HO1)
 *     MH_j = BO_j mod Ps_j                  (remainder, HO2; Ps = pentatope key)
 *     CT  += "f" + DH_j + "r" + MH_j
 *
 * Decryption reverses it:
 *     E_j  = digits between "f" and "r"     (= DH_j)
 *     RE_j = digits between "r" and next "f" (= MH_j)
 *     S_j  = E_j * Ps_j + RE_j              (HO3, HO4)  = BO_j
 *     C_j  = chr(S_j XOR Ts_j)
 *
 * The paper calls division/modulus and their inverses "homomorphic
 * operations". They are not homomorphic encryption in the modern sense; see
 * the notes below.
 */

/** Tetrahedral number: T(n) = n(n+1)(n+2)/6. */
export function tetrahedral(n) {
  const b = BigInt(n);
  return (b * (b + 1n) * (b + 2n)) / 6n;
}

/** Pentatope number: P(n) = n(n+1)(n+2)(n+3)/24. */
export function pentatope(n) {
  const b = BigInt(n);
  return (b * (b + 1n) * (b + 2n) * (b + 3n)) / 24n;
}

/**
 * Bytes to encrypt. The paper says "ASCII value of each character"; we use the
 * UTF-8 bytes instead, which is identical for ASCII input and additionally
 * round-trips names with accents or Devanagari.
 */
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** Cryptographically random integer in [min, max]. */
function randomIndex(min, max) {
  const span = max - min + 1;
  const buf = new Uint32Array(1);
  // Rejection sampling, so the distribution stays uniform.
  const limit = Math.floor(0xffffffff / span) * span;
  let v;
  do {
    crypto.getRandomValues(buf);
    v = buf[0];
  } while (v >= limit);
  return min + (v % span);
}

/**
 * Generate a key pair for a message of `length` bytes.
 *
 * The paper only says the keys are "generated randomly" and of "variable
 * length". We pick one random starting index per key and take the run of
 * figurate numbers from there, which is enough to reproduce the scheme while
 * keeping the key compact enough to travel in a QR code.
 *
 * The pentatope index starts at 2 so that P(n) >= 5: an index of 0 would make
 * the modulus zero (division by zero) and an index of 1 gives P = 1, which
 * makes every remainder 0 and leaks the whole value in the quotient.
 */
export function generateKeys(length, { tetraStart, pentaStart } = {}) {
  const tStart = tetraStart ?? randomIndex(1, 400);
  const pStart = pentaStart ?? randomIndex(2, 200);

  const Ts = [];
  const Ps = [];
  for (let j = 0; j < length; j++) {
    Ts.push(tetrahedral(tStart + j));
    Ps.push(pentatope(pStart + j));
  }
  return { Ts, Ps, tetraStart: tStart, pentaStart: pStart, length };
}

/** Serializable key form, small enough for a QR code or a share link. */
export function exportKey(key) {
  return { t: key.tetraStart, p: key.pentaStart, n: key.length };
}

export function importKey({ t, p, n }) {
  return generateKeys(n, { tetraStart: t, pentaStart: p });
}

/**
 * Algorithm 1 — encryption.
 * @param {string} plaintext
 * @param {object} [key] key from generateKeys(); generated if omitted
 * @returns {{ ciphertext: string, key: object }}
 */
export function encrypt(plaintext, key) {
  const bytes = utf8.encode(plaintext);
  const k = key ?? generateKeys(bytes.length);

  if (k.length < bytes.length) {
    throw new Error(
      `key covers ${k.length} bytes but the message needs ${bytes.length}`
    );
  }

  let ciphertext = "";
  for (let j = 0; j < bytes.length; j++) {
    const BO = BigInt(bytes[j]) ^ k.Ts[j]; // step 5
    const DH = BO / k.Ps[j]; // HO1
    const MH = BO % k.Ps[j]; // HO2
    ciphertext += `f${DH}r${MH}`; // step 7
  }

  return { ciphertext, key: k };
}

/**
 * Algorithm 4 — decryption.
 * @param {string} ciphertext
 * @param {object} key key from generateKeys()/importKey()
 * @returns {string}
 */
export function decrypt(ciphertext, key) {
  // Each block looks like f<digits>r<digits>. Anchored so stray characters
  // cause a parse failure rather than silently decoding to garbage.
  const blocks = [...ciphertext.matchAll(/f(\d+)r(\d+)/g)];

  const joined = blocks.reduce((n, b) => n + b[0].length, 0);
  if (joined !== ciphertext.length) {
    throw new Error("ciphertext is malformed: unexpected characters");
  }
  if (blocks.length > key.length) {
    throw new Error(
      `ciphertext has ${blocks.length} blocks but the key covers ${key.length}`
    );
  }

  const out = new Uint8Array(blocks.length);
  for (let j = 0; j < blocks.length; j++) {
    const E = BigInt(blocks[j][1]); // step 4
    const RE = BigInt(blocks[j][2]);
    const S = E * key.Ps[j] + RE; // HO3, HO4
    const BO = S ^ key.Ts[j]; // step 6
    if (BO < 0n || BO > 255n) {
      throw new Error(`decryption failed at position ${j}: wrong key`);
    }
    out[j] = Number(BO);
  }

  return fromUtf8.decode(out);
}

/*
 * SECURITY NOTES — cite these in the report's discussion section.
 *
 * 1. It is not homomorphic encryption. Homomorphic encryption lets a third
 *    party compute on ciphertext without the key. Here the division and
 *    modulus are applied by the key holder during encryption; nobody can
 *    operate on the ciphertext afterwards. The name in the paper is a
 *    misnomer.
 *
 * 2. The keystream is not random. Tetrahedral and pentatope numbers are a
 *    fixed, publicly known sequence, so the whole key is just two starting
 *    indices. With the ranges above that is well under 2^17 possibilities —
 *    a brute force finishes instantly. The paper's Proposition 3 claims
 *    n^3 * m work for an attacker, but that counts guesses over the *values*
 *    rather than over the two indices that actually determine them.
 *
 * 3. Ps_j is recoverable from the ciphertext alone. For any j, BO_j =
 *    DH_j * Ps_j + MH_j and BO_j is at most 255 XOR Ts_j. Given several
 *    characters the candidate moduli are heavily constrained, so a
 *    ciphertext-only attack is far easier than Proposition 2 suggests.
 *
 * 4. Each byte is encrypted independently with a position-dependent key and
 *    no authentication tag. Identical plaintext bytes at the same offset
 *    always give identical blocks, and anyone can cut, splice or reorder
 *    blocks without detection. The on-chain keccak256 digest is what actually
 *    catches tampering in this system, not the cipher.
 *
 * 5. Ciphertext expansion is roughly 15-20x, because every byte becomes two
 *    decimal numbers plus delimiters.
 *
 * This is exactly why the project also ships lib/aes-cipher.mjs. Compare the
 * two: that comparison is the contribution over the paper.
 */
