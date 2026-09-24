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
lib/ipfs.mjs                    Pinata pinning + multi-gateway fetch
test-lib/crypto.test.mjs        23 crypto and packaging tests
scripts/deploy.js               deploy + write deployments/<network>.json
scripts/demo.mjs                full end-to-end walkthrough (the viva demo)
scripts/issue.mjs               issue for real: encrypt, pin, anchor, make a QR
scripts/setup-solc-offline.js   makes compiling work behind a firewall
scripts/doctor.mjs              one-shot config check (env, RPC, Pinata, deploy)
scripts/bench-cipher.mjs        cipher comparison: speed, size, brute-force
scripts/bench-chain.mjs         gas, cost, latency, throughput
scripts/make-charts.mjs         CSVs -> SVG charts + results/report.html
frontend/                       React dApp (Verify, Issue, Admin)
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

## Running it for real on Polygon Amoy

```bash
# 1. configure
cp .env.example .env            # PRIVATE_KEY, PINATA_JWT
cp frontend/.env.example frontend/.env.local   # VITE_PINATA_JWT

# 2. deploy — writes frontend/src/contract.json automatically
npm run deploy:amoy

# 3. issue one from the command line (prints a QR code in the terminal)
npx hardhat run scripts/issue.mjs --network amoy

# 4. or run the dApp
cd frontend && npm install && npm run dev
```

The dApp has three pages:

- **Verify** — needs no wallet at all. Scanning the QR code opens it with
  everything prefilled and the check runs on load. Integrity is confirmed
  before, and independently of, decryption.
- **Issue** — connects MetaMask, encrypts in the browser, pins to IPFS,
  anchors on chain, and produces the student's QR code.
- **Admin** — manage issuer addresses (owner only) and revoke (issuer only).

### About the Pinata key in the frontend

Anything named `VITE_*` is compiled into the JavaScript the browser downloads,
so `VITE_PINATA_JWT` is **not secret** once the app is deployed. That is
acceptable for a mini project. In a production system the upload would go
through a small backend holding the key server-side. Use a Pinata key scoped
to `pinJSONToIPFS` only, and revoke it when the project is marked.

## Evaluation

```bash
npm run bench:cipher          # paper's cipher vs AES-256-GCM
npm run bench:chain           # gas + latency, local chain
npm run bench:chain:amoy      # same, on the real testnet (costs test POL)
npm run charts                # -> results/charts/*.svg + results/report.html
```

`npm run evaluate` runs the lot. Open `results/report.html` for everything on
one page; the individual SVGs in `results/charts/` paste into Word and stay
sharp at any size.

One caveat to carry into the write-up: on a local Hardhat node every
transaction mines instantly, so local latency and throughput measure the node
software, not blockchain consensus. The paper has the same problem — it reports
sub-millisecond latencies, which no real network achieves. Use the Amoy run for
the latency and throughput figures; gas figures are identical either way,
because gas depends on the bytecode rather than the network.

## Status

- [x] Week 1 — contract, tests, deploy script
- [x] Week 2a — both ciphers, packaging layer, tests, end-to-end demo
- [x] Week 2b — real IPFS (Pinata), React dApp, QR codes
- [x] Week 3a — benchmarks and charts
- [ ] Week 3b — run benchmarks on Amoy, write the report

## Licence

MIT. The paper it implements is CC BY; it is cited above as required.
