# CertChain contracts

| Contract | Purpose | Key functions | Who can call them |
|---|---|---|---|
| `InstitutionRegistry` | Approved universities and names | `addInstitution`, `removeInstitution`, `isApproved`, `getName`, `transferOwnership` | Owner manages; anyone reads |
| `CertificateSBT` | Soulbound ERC-721 certificate ownership | `mint`, `burn`, `tokenURI`, `tokenOfOwnerByIndex`, `setMinter` | Registry is the one-time minter; registry burns; owner sets minter |
| `CertRegistry` | Single-certificate integrity and lifecycle | `issueCertificate`, `verifyCertificate`, `getCertificate`, `revokeCertificate`, `computeCertId` | Approved institutions issue; original issuer revokes; anyone verifies |
| `AccessManager` | Advisory verifier access and audit events | `grantAccess`, `revokeAccess`, `hasAccess`, `recordVerification` | SBT owner manages access; anyone may record a verification |
| `BatchRegistry` | Merkle-root anchoring for certificates without SBTs | `anchorBatch`, `verifyInBatch`, `revokeInBatch` | Approved institutions anchor; batch issuer revokes; anyone verifies |

The certificate data is encrypted and pinned to IPFS before the final chain
write. Batch payloads contain their Merkle root and proof beside the
ciphertext; those fields are not included in the ciphertext digest. Batch
certificates deliberately do not receive SBTs, which saves one mint per
certificate but means they do not appear in “My certificates”.
