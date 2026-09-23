const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const Status = { NotFound: 0n, Valid: 1n, Tampered: 2n, Revoked: 3n };

const CID = "bafkreialgb7dwnhqcpcrnp4nwpqhbnc7bbnrmcmvlmvo6qkf7cqhbkjdqa";
const HASH = ethers.keccak256(ethers.toUtf8Bytes("encrypted-certificate-bytes"));
const OTHER_HASH = ethers.keccak256(ethers.toUtf8Bytes("tampered-bytes"));

describe("CertRegistry", function () {
  async function deploy() {
    const [owner, registrar, otherUni, student, employer] =
      await ethers.getSigners();
    const registry = await ethers.deployContract("CertRegistry");
    const certId = await registry.computeCertId("S2024CS042", "B.Tech CSE", "2026-06-15");
    return { registry, owner, registrar, otherUni, student, employer, certId };
  }

  describe("deployment", function () {
    it("makes the deployer the owner and the first issuer", async function () {
      const { registry, owner } = await loadFixture(deploy);
      expect(await registry.owner()).to.equal(owner.address);
      expect(await registry.isIssuer(owner.address)).to.equal(true);
      expect(await registry.totalIssued()).to.equal(0n);
    });

    it("does not make a random account an issuer", async function () {
      const { registry, student } = await loadFixture(deploy);
      expect(await registry.isIssuer(student.address)).to.equal(false);
    });
  });

  describe("issuer management", function () {
    it("lets the owner whitelist a university", async function () {
      const { registry, registrar } = await loadFixture(deploy);
      await expect(registry.addIssuer(registrar.address))
        .to.emit(registry, "IssuerAdded")
        .withArgs(registrar.address);
      expect(await registry.isIssuer(registrar.address)).to.equal(true);
    });

    it("rejects a non-owner trying to whitelist themselves", async function () {
      const { registry, student } = await loadFixture(deploy);
      await expect(
        registry.connect(student).addIssuer(student.address)
      ).to.be.revertedWithCustomError(registry, "NotOwner");
    });

    it("rejects the zero address", async function () {
      const { registry } = await loadFixture(deploy);
      await expect(
        registry.addIssuer(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("lets the owner remove an issuer, who can then no longer issue", async function () {
      const { registry, registrar, certId } = await loadFixture(deploy);
      await registry.addIssuer(registrar.address);
      await expect(registry.removeIssuer(registrar.address))
        .to.emit(registry, "IssuerRemoved")
        .withArgs(registrar.address);

      await expect(
        registry.connect(registrar).issueCertificate(certId, CID, HASH)
      ).to.be.revertedWithCustomError(registry, "NotIssuer");
    });

    it("transfers ownership", async function () {
      const { registry, owner, registrar } = await loadFixture(deploy);
      await expect(registry.transferOwnership(registrar.address))
        .to.emit(registry, "OwnershipTransferred")
        .withArgs(owner.address, registrar.address);
      expect(await registry.owner()).to.equal(registrar.address);
    });
  });

  describe("issuing", function () {
    it("stores the record and emits the event", async function () {
      const { registry, owner, certId } = await loadFixture(deploy);

      await expect(registry.issueCertificate(certId, CID, HASH))
        .to.emit(registry, "CertificateIssued")
        .withArgs(certId, owner.address, CID, HASH, anyUint64());

      const cert = await registry.getCertificate(certId);
      expect(cert.cid).to.equal(CID);
      expect(cert.dataHash).to.equal(HASH);
      expect(cert.issuer).to.equal(owner.address);
      expect(cert.issuedAt).to.be.greaterThan(0n);
      expect(cert.revokedAt).to.equal(0n);
      expect(await registry.totalIssued()).to.equal(1n);
    });

    it("rejects an account that is not a whitelisted issuer", async function () {
      const { registry, student, certId } = await loadFixture(deploy);
      await expect(
        registry.connect(student).issueCertificate(certId, CID, HASH)
      ).to.be.revertedWithCustomError(registry, "NotIssuer");
    });

    it("rejects a duplicate certId", async function () {
      const { registry, certId } = await loadFixture(deploy);
      await registry.issueCertificate(certId, CID, HASH);
      await expect(registry.issueCertificate(certId, CID, HASH))
        .to.be.revertedWithCustomError(registry, "AlreadyIssued")
        .withArgs(certId);
    });

    it("rejects empty or zero inputs", async function () {
      const { registry, certId } = await loadFixture(deploy);
      await expect(
        registry.issueCertificate(ethers.ZeroHash, CID, HASH)
      ).to.be.revertedWithCustomError(registry, "ZeroCertId");
      await expect(
        registry.issueCertificate(certId, "", HASH)
      ).to.be.revertedWithCustomError(registry, "EmptyCid");
      await expect(
        registry.issueCertificate(certId, CID, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(registry, "ZeroHash");
    });

    it("counts certificates from several issuers", async function () {
      const { registry, registrar, certId } = await loadFixture(deploy);
      await registry.addIssuer(registrar.address);
      const other = await registry.computeCertId("S2024EC007", "B.Tech ECE", "2026-06-15");

      await registry.issueCertificate(certId, CID, HASH);
      await registry.connect(registrar).issueCertificate(other, CID, OTHER_HASH);

      expect(await registry.totalIssued()).to.equal(2n);
    });
  });

  describe("verification", function () {
    it("returns Valid for an untouched certificate", async function () {
      const { registry, certId } = await loadFixture(deploy);
      await registry.issueCertificate(certId, CID, HASH);

      const [status, cert] = await registry.verifyCertificate(certId, HASH);
      expect(status).to.equal(Status.Valid);
      expect(cert.cid).to.equal(CID);
    });

    it("returns Tampered when the IPFS file no longer hashes to the record", async function () {
      const { registry, certId } = await loadFixture(deploy);
      await registry.issueCertificate(certId, CID, HASH);

      const [status] = await registry.verifyCertificate(certId, OTHER_HASH);
      expect(status).to.equal(Status.Tampered);
    });

    it("returns NotFound for an id that was never issued", async function () {
      const { registry } = await loadFixture(deploy);
      const ghost = await registry.computeCertId("S9999XX999", "Nothing", "1999-01-01");

      const [status, cert] = await registry.verifyCertificate(ghost, HASH);
      expect(status).to.equal(Status.NotFound);
      expect(cert.issuedAt).to.equal(0n);
    });

    it("can be called by anyone with no gas and no wallet balance", async function () {
      const { registry, employer, certId } = await loadFixture(deploy);
      await registry.issueCertificate(certId, CID, HASH);

      // staticCall proves it is a pure read: no transaction, no ETH spent.
      const balanceBefore = await ethers.provider.getBalance(employer.address);
      const [status] = await registry
        .connect(employer)
        .verifyCertificate.staticCall(certId, HASH);
      const balanceAfter = await ethers.provider.getBalance(employer.address);

      expect(status).to.equal(Status.Valid);
      expect(balanceAfter).to.equal(balanceBefore);
    });

    it("reverts getCertificate for an unknown id", async function () {
      const { registry } = await loadFixture(deploy);
      const ghost = await registry.computeCertId("a", "b", "c");
      await expect(registry.getCertificate(ghost))
        .to.be.revertedWithCustomError(registry, "UnknownCertificate")
        .withArgs(ghost);
    });
  });

  describe("revocation", function () {
    it("marks the certificate revoked and keeps the record", async function () {
      const { registry, owner, certId } = await loadFixture(deploy);
      await registry.issueCertificate(certId, CID, HASH);

      await expect(registry.revokeCertificate(certId, "degree rescinded"))
        .to.emit(registry, "CertificateRevoked")
        .withArgs(certId, owner.address, "degree rescinded", anyUint64());

      const [status, cert] = await registry.verifyCertificate(certId, HASH);
      expect(status).to.equal(Status.Revoked);
      expect(cert.cid).to.equal(CID); // history preserved, not deleted
      expect(await registry.isValid(certId)).to.equal(false);
    });

    it("stops one university revoking another's certificate", async function () {
      const { registry, otherUni, certId } = await loadFixture(deploy);
      await registry.addIssuer(otherUni.address);
      await registry.issueCertificate(certId, CID, HASH);

      await expect(
        registry.connect(otherUni).revokeCertificate(certId, "malicious")
      ).to.be.revertedWithCustomError(registry, "NotIssuer");

      expect(await registry.isValid(certId)).to.equal(true);
    });

    it("rejects revoking twice", async function () {
      const { registry, certId } = await loadFixture(deploy);
      await registry.issueCertificate(certId, CID, HASH);
      await registry.revokeCertificate(certId, "first");
      await expect(registry.revokeCertificate(certId, "second"))
        .to.be.revertedWithCustomError(registry, "AlreadyRevoked")
        .withArgs(certId);
    });

    it("rejects revoking something that was never issued", async function () {
      const { registry } = await loadFixture(deploy);
      const ghost = await registry.computeCertId("x", "y", "z");
      await expect(
        registry.revokeCertificate(ghost, "nope")
      ).to.be.revertedWithCustomError(registry, "UnknownCertificate");
    });

    it("reports Tampered rather than Revoked when the file was also altered", async function () {
      const { registry, certId } = await loadFixture(deploy);
      await registry.issueCertificate(certId, CID, HASH);
      await registry.revokeCertificate(certId, "rescinded");

      // Integrity is checked before revocation status, so a forged file is
      // flagged as tampering even on a revoked record.
      const [status] = await registry.verifyCertificate(certId, OTHER_HASH);
      expect(status).to.equal(Status.Tampered);
    });
  });

  describe("certId derivation", function () {
    it("is deterministic and matches an off-chain ethers computation", async function () {
      const { registry } = await loadFixture(deploy);
      const onChain = await registry.computeCertId("S1", "B.Tech", "2026-01-01");
      const offChain = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "string", "string"],
          ["S1", "B.Tech", "2026-01-01"]
        )
      );
      expect(onChain).to.equal(offChain);
    });

    it("gives different ids for different students", async function () {
      const { registry } = await loadFixture(deploy);
      const a = await registry.computeCertId("S1", "B.Tech", "2026-01-01");
      const b = await registry.computeCertId("S2", "B.Tech", "2026-01-01");
      expect(a).to.not.equal(b);
    });
  });
});

// Matcher helper: timestamps come from the chain, so just assert it is set.
function anyUint64() {
  return (value) => value > 0n;
}
