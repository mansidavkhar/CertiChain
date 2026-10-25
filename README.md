# CertChain

CertChain is a blockchain academic-certificate verifier. Certificate details
are encrypted in the browser, pinned to IPFS, and anchored on Polygon Amoy
with a ciphertext digest. A verifier can check authenticity for free without a
wallet; the decryption key remains off-chain.

## Architecture

The project uses five contracts:

| Contract | Responsibility |
|---|---|
| `InstitutionRegistry` | Owner-managed approved institutions and display names |
| `CertificateSBT` | Soulbound ERC-721 tokens for single certificates |
| `CertRegistry` | Single-certificate issue, verify, revoke, and certificate records |
| `AccessManager` | Advisory access grants and on-chain verification audit events |
| `BatchRegistry` | Merkle-root anchoring and verification for certificate batches |

Deployment order:

```text
InstitutionRegistry
CertificateSBT
CertRegistry(institutionRegistry, sbt)
sbt.setMinter(certRegistry)
AccessManager(certRegistry, sbt)
BatchRegistry(institutionRegistry)
```

See [docs/CONTRACTS.md](docs/CONTRACTS.md) for functions and caller rules.

### Single certificates

The certificate ID remains:

```text
keccak256(abi.encode(studentId, course, issueDate))
```

The lifecycle is always:

```text
encrypt -> pin to IPFS -> write to the chain last
```

Only the CID, ciphertext digest, issuer, timestamps, and revocation state are
stored on-chain. The four verification states are:

```text
NotFound | Valid | Tampered | Revoked
```

Issuing a single certificate can mint a soulbound token to a student wallet.
Transfers between non-zero addresses are rejected. Revoking the certificate
burns its SBT while preserving the certificate record for verification history.

### Batch certificates

`lib/batch.mjs` encrypts all inputs, computes each `certId` and `dataHash`, and
builds an OpenZeppelin StandardMerkleTree. Each pinned payload contains:

```json
{
  "ciphertext": "...",
  "batchRoot": "0x...",
  "proof": ["0x..."]
}
```

The root is anchored only after every payload is pinned. Proof metadata is
outside the ciphertext, so `dataHash` remains computable before pinning.
`BatchRegistry.verifyInBatch` recomputes the standard leaf:

```text
keccak256(bytes.concat(keccak256(abi.encode(certId, dataHash))))
```

Batch certificates do not receive SBTs. This saves one mint per certificate but
means they do not appear on the My certificates page.

## Repository layout

```text
contracts/
  InstitutionRegistry.sol
  CertificateSBT.sol
  CertRegistry.sol
  AccessManager.sol
  BatchRegistry.sol
lib/
  aes-cipher.mjs       AES-256-GCM encryption
  paper-cipher.mjs     cipher from the referenced paper
  certificate.mjs      canonical JSON, IDs, hashes, packaging
  batch.mjs            Merkle batch preparation and IPFS pinning
  ipfs.mjs              Pinata pinning and racing gateway fetches
scripts/
  deploy.js             deploy all five contracts and write ABIs
  issue.mjs             command-line single-certificate issuing
  doctor.mjs            configuration and deployment diagnostics
  bench-chain.mjs       Amoy gas, latency, and throughput benchmark
  bench-cipher.mjs      cipher comparison benchmark
  make-charts.mjs       CSV results to SVG charts
frontend/
  src/pages/Verify.jsx
  src/pages/Issue.jsx
  src/pages/Admin.jsx
  src/pages/MyCertificates.jsx
test/                    Hardhat contract tests
test-lib/                encryption, packaging, and batch-library tests
deployments/amoy.json    deployed Amoy addresses and ABIs
```

## Windows quick start

Run these commands from PowerShell:

```powershell
npm install
npm run test:all
Copy-Item .env.example .env
Copy-Item frontend\.env.example frontend\.env.local
```

Configure `AMOY_RPC_URL`, a funded Amoy `PRIVATE_KEY`, and `PINATA_JWT` in
`.env`. Configure `VITE_PINATA_JWT` and, optionally, `VITE_RPC_URL` and
`VITE_PINATA_GATEWAY` in `frontend\.env.local`.

Never print or commit either environment file. The only real network supported
by this project is Polygon Amoy. Unit tests use Hardhat's built-in in-memory
network; Ganache and a local node are not required.

## Deploying to Polygon Amoy

```powershell
npm run deploy:amoy
npm run doctor
```

The deployment script writes all five addresses and ABIs to:

```text
deployments\amoy.json
frontend\src\contract.json
```

The deployer must have Amoy POL. Get test funds from the
[Polygon faucet](https://faucet.polygon.technology/).

## Running the frontend

```powershell
cd frontend
npm install
npm run dev
```

The dApp is Amoy-only and displays a warning if MetaMask is connected to
another network.

### Admin

The deployment owner can add or remove institutions and see institution names.
An approved institution can issue and revoke its own single certificates.

### Issue

The Single tab encrypts, pins, and issues one certificate. The optional Student
wallet address receives the soulbound certificate token.

The Batch tab accepts a CSV with:

```text
studentId,studentName,course,grade,issueDate,wallet
```

It previews rows, encrypts and pins every payload, submits one
`anchorBatch` transaction, and downloads a verification CSV.

### My certificates

The connected student wallet lists SBTs with
`tokenOfOwnerByIndex`, rather than log queries. Each token has a Verify link,
an access-grant form, and a revoke-access button.

For a demonstration, create or import a second MetaMask account, issue to its
public address, then switch MetaMask to that account and open My certificates.
Never share the account's private key.

### Verify

Verification works without a wallet. Single links carry the certificate ID and
CID. Batch links use the root and proof embedded in the fetched IPFS payload.
The page reports RPC or gateway failures as errors, never as certificate
verdicts. A successful verification can optionally be recorded with
`AccessManager.recordVerification`.

## Tests

```powershell
npm run test:all
```

The current suite contains **24 passing tests**:

- 8 Hardhat contract tests covering all five contracts and an end-to-end flow
- 16 library subtests covering both ciphers, packaging, and Merkle proofs

## Benchmarks and results

Amoy benchmarks use real testnet transactions and require a funded deployer:

```powershell
npm run bench:chain:amoy
```

The benchmark measures deployment gas for all five contracts, institution
management, single issue including SBT mint, revoke including burn, access
operations, verification logging, batch anchoring, and batch revocation. It
also builds fake off-chain Merkle trees for N = 10, 50, 100, and 500 and writes
the gas-per-certificate comparison between repeated single issuing and one
`anchorBatch` transaction for each N. Results are written as Amoy gas, cost,
performance, and batch-comparison CSVs under `results\`.

Run the cipher benchmark and chart generation with:

```powershell
npm run bench:cipher
npm run charts
```

The batch comparison is charted as
`results\charts\chain-batch.svg` when `chain-batch-amoy.csv` is available.

Local Hardhat runs are useful for deterministic unit-test gas checks only.
Their latency and throughput do not represent blockchain consensus. Use the
Amoy output for network performance claims.

## Cryptography note

The paper's cipher is retained for comparison, but it is not authenticated and
has a small brute-force key space. AES-256-GCM is the recommended scheme.
Regardless of scheme, the on-chain digest protects the integrity of the exact
ciphertext pinned to IPFS.

## Differences from the referenced paper

- On-chain institution approval replaces a local username/password database.
- Verification is a free public `view` call.
- AES-256-GCM is available alongside the paper's cipher.
- IPFS stores encrypted payloads and the chain stores only public integrity
  metadata.
- Merkle batches reduce chain writes but intentionally do not mint SBTs.

## Licence

MIT. The referenced paper is open access under CC BY and is cited above.
