# CertChain — blockchain + IPFS academic certificate verification

A mini project implementing the framework of:

> S. A. Sultana, C. Rupa, R. P. Malleswari and T. R. Gadekallu,
> "IPFS-Blockchain Smart Contracts Based Conceptual Framework to Reduce
> Certificate Frauds in the Academic Field", *Information*, vol. 14, no. 8,
> art. 446, 2023. https://doi.org/10.3390/info14080446 (open access, CC BY)

A university issues a degree certificate. The certificate itself is encrypted
and stored on IPFS; only its content identifier and a `keccak256` digest of the
ciphertext are written to Ethereum. Anyone can then check that a certificate is
genuine, unmodified and not revoked, for free, without contacting the
university and without being able to read the certificate.

## How it works

```
Issuer (university)                                  Verifier (employer)
─────────────────────                                ───────────────────
certificate fields                                   scan QR → certId + key
        │                                                    │
   canonical JSON                                     read record on-chain
        │                                             (CID, dataHash, revoked)
   encrypt  ──► key ──► QR code ──► student ─────────────────┤
        │                                                    │
   ciphertext ──► IPFS ──► CID                        fetch CID from IPFS
        │                                                    │
   keccak256(ciphertext) = dataHash                   keccak256(fetched)
        │                                                    │
   issueCertificate(certId, CID, dataHash)            compare ──► Valid /
        │                                                          Tampered /
        ▼                                                          Revoked
   CertRegistry on Ethereum                          decrypt with key (optional)
```

Three properties fall out of this:

- **Integrity.** The digest is over the ciphertext bytes on IPFS. Change one
  character of that file and verification returns `Tampered`.
- **Confidentiality.** The chain holds no personal data. The decryption key
  travels with the student, so they choose who can read the certificate.
- **No gatekeeper.** `verifyCertificate` is a `view` function, so an employer
  needs no wallet, no ETH and no account with the university.

## What differs from the paper, and why

| Paper | Here | Reason |
|---|---|---|
| Name/password checked against a local DB | On-chain issuer whitelist | A password check off-chain is not verifiable by anyone else. An address cannot be forged. |
| Viewing requires an ETH balance above a threshold | Verification is a free `view` call | Charging for verification defeats the point of a public trust anchor. |
| Local test chain / Ropsten | Hardhat, then Sepolia or Polygon Amoy | Ropsten and the other old testnets were shut down in 2022–23. |
| Key handling unspecified | Key is issued to the student in the QR code | Makes the privacy claim concrete and student-controlled. |
| "Lightweight homomorphic" cipher only | Same cipher **plus** AES-256-GCM, benchmarked against each other | See below. |

### On the paper's cipher

The paper's Algorithm 1 is reimplemented faithfully in `lib/paper-cipher.mjs`,
with the paper's own notation in the comments. It is worth being straight about
its weaknesses, because a reviewer will ask:

- It is **not homomorphic encryption**. The division and modulus are applied by
  the key holder at encryption time; no third party can compute on the
  ciphertext. The name is a misnomer.
- The keystream is a **publicly known sequence** (tetrahedral and pentatope
  numbers), so the entire key reduces to two starting indices. `npm run test:lib`
  contains a test that brute-forces the key in well under a second. The paper's
  Proposition 3 counts guesses over key *values* rather than over the two
  indices that generate them.
- There is **no authentication tag**, so blocks can be cut, spliced or
  reordered undetected. In this system the on-chain digest is what actually
  catches tampering, not the cipher.
- Ciphertext expands roughly 15–20×.

`lib/aes-cipher.mjs` provides AES-256-GCM through the Web Crypto API as the
alternative. Both schemes work end to end; comparing them on speed, size and
security properties is the project's contribution over the paper.

## Layout

```
contracts/CertRegistry.sol      the smart contract (issue, verify, revoke, view)
test/CertRegistry.test.js       24 contract tests
lib/paper-cipher.mjs            the paper's Algorithms 1 and 4
lib/aes-cipher.mjs              AES-256-GCM alternative
lib/certificate.mjs             canonical JSON, certId, digest, packaging
test-lib/crypto.test.mjs        23 crypto and packaging tests
scripts/deploy.js               deploy + write deployments/<network>.json
scripts/demo.mjs                full end-to-end walkthrough (the viva demo)
scripts/setup-solc-offline.js   makes compiling work behind a firewall
```

## Getting started

```bash
npm install
npm run test:all      # 47 tests: contract + crypto
npx hardhat run scripts/demo.mjs
```

`npm install` also runs `scripts/setup-solc-offline.js`, which installs the
Solidity compiler from the npm `solc` package into Hardhat's cache. Hardhat
normally downloads it from `binaries.soliditylang.org`; if your network blocks
that host you get `HH502: Couldn't download compiler version list`, and this
script is the fix. On an unrestricted network it is harmless.

### Deploying to a testnet

```bash
cp .env.example .env     # fill in RPC URL and a throwaway private key
npm run deploy:sepolia   # or: npm run deploy:amoy
```

Get test funds from a Sepolia faucet or from `faucet.polygon.technology` for
Amoy. **Never put a private key with real funds in `.env`.**

### Measuring gas

```bash
npm run gas
```

## Status

- [x] Week 1 — contract, tests, deploy script
- [x] Week 2a — both ciphers, packaging layer, tests, end-to-end demo
- [ ] Week 2b — real IPFS (Pinata), React dApp, QR codes
- [ ] Week 3 — evaluation (gas, latency, throughput, cipher comparison), report

## Licence

MIT. The paper it implements is CC BY; it is cited above as required.
