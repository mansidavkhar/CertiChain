const { expect } = require("chai");
const { ethers } = require("hardhat");
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const Status = { NotFound: 0n, Valid: 1n, Tampered: 2n, Revoked: 3n };
const CID = "bafkrei-cert";
const HASH = ethers.keccak256(ethers.toUtf8Bytes("ciphertext"));
const OTHER_HASH = ethers.keccak256(ethers.toUtf8Bytes("tampered"));

async function deploy() {
  const [owner, institution, other, student, verifier] = await ethers.getSigners();
  const institutions = await ethers.deployContract("InstitutionRegistry");
  const sbt = await ethers.deployContract("CertificateSBT");
  const registry = await ethers.deployContract("CertRegistry", [
    institutions.target, sbt.target,
  ]);
  await sbt.setMinter(registry.target);
  const access = await ethers.deployContract("AccessManager", [registry.target, sbt.target]);
  const batch = await ethers.deployContract("BatchRegistry", [institutions.target]);
  const certId = await registry.computeCertId("S1", "B.Tech", "2026-01-01");
  await institutions.addInstitution(owner.address, "Owner University");
  return { owner, institution, other, student, verifier, institutions, sbt, registry, access, batch, certId };
}

describe("CertChain contract architecture", function () {
  it("manages institutions and ownership", async function () {
    const { institutions, owner, institution, other } = await loadFixture(deploy);
    await expect(institutions.addInstitution(institution.address, "Example Institute"))
      .to.emit(institutions, "InstitutionAdded").withArgs(institution.address, "Example Institute");
    expect(await institutions.isApproved(institution.address)).to.equal(true);
    expect(await institutions.getName(institution.address)).to.equal("Example Institute");
    await expect(institutions.connect(other).removeInstitution(institution.address))
      .to.be.revertedWithCustomError(institutions, "NotOwner");
    await institutions.removeInstitution(institution.address);
    expect(await institutions.isApproved(institution.address)).to.equal(false);
    await institutions.transferOwnership(other.address);
    expect(await institutions.owner()).to.equal(other.address);
    expect(owner.address).to.not.equal(other.address);
  });

  it("issues, verifies and derives the original cert id", async function () {
    const { registry, certId, owner, student, sbt } = await loadFixture(deploy);
    await expect(registry.issueCertificate(certId, CID, HASH, student.address))
      .to.emit(registry, "CertificateIssued");
    const [status, cert] = await registry.verifyCertificate(certId, HASH);
    expect(status).to.equal(Status.Valid);
    expect(cert.issuer).to.equal(owner.address);
    expect(await sbt.ownerOf(BigInt(certId))).to.equal(student.address);
    expect(await sbt.tokenURI(BigInt(certId))).to.equal(`ipfs://${CID}`);
    expect(await registry.totalIssued()).to.equal(1n);
    expect((await registry.computeCertId("S1", "B.Tech", "2026-01-01"))).to.equal(certId);
  });

  it("rejects removed institutions for both registries", async function () {
    const { institutions, registry, batch, institution, certId } = await loadFixture(deploy);
    await institutions.addInstitution(institution.address, "Other");
    await institutions.removeInstitution(institution.address);
    await expect(registry.connect(institution).issueCertificate(certId, CID, HASH, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(registry, "NotIssuer");
    await expect(batch.connect(institution).anchorBatch(ethers.keccak256(ethers.toUtf8Bytes("r")), 1, "x"))
      .to.be.revertedWithCustomError(batch, "NotIssuer");
  });

  it("keeps the four verification states and only the issuer can revoke", async function () {
    const { registry, certId, owner, other } = await loadFixture(deploy);
    const ghost = await registry.computeCertId("ghost", "x", "y");
    expect((await registry.verifyCertificate(ghost, HASH))[0]).to.equal(Status.NotFound);
    await registry.issueCertificate(certId, CID, HASH, ethers.ZeroAddress);
    expect((await registry.verifyCertificate(certId, OTHER_HASH))[0]).to.equal(Status.Tampered);
    await expect(registry.connect(other).revokeCertificate(certId, "bad"))
      .to.be.revertedWithCustomError(registry, "NotIssuer");
    await expect(registry.revokeCertificate(certId, "rescinded")).to.emit(registry, "CertificateRevoked");
    expect((await registry.verifyCertificate(certId, HASH))[0]).to.equal(Status.Revoked);
    expect(await registry.isValid(certId)).to.equal(false);
    expect(owner.address).to.equal((await registry.getCertificate(certId)).issuer);
  });

  it("enforces soulbound and minter rules and burns on revoke", async function () {
    const { sbt, registry, certId, student, other } = await loadFixture(deploy);
    await expect(sbt.connect(other).mint(student.address, certId, CID))
      .to.be.revertedWithCustomError(sbt, "NotMinter");
    await registry.issueCertificate(certId, CID, HASH, student.address);
    await expect(sbt.connect(student).transferFrom(student.address, other.address, BigInt(certId)))
      .to.be.revertedWithCustomError(sbt, "Soulbound");
    await registry.revokeCertificate(certId, "withdrawn");
    await expect(sbt.ownerOf(BigInt(certId))).to.be.reverted;
  });

  it("grants, expires, revokes access and records an audit event", async function () {
    const { registry, access, certId, student, verifier } = await loadFixture(deploy);
    await registry.issueCertificate(certId, CID, HASH, student.address);
    await access.connect(student).grantAccess(certId, verifier.address, (await time.latest()) + 100);
    expect(await access.hasAccess(certId, verifier.address)).to.equal(true);
    await time.increase(101);
    expect(await access.hasAccess(certId, verifier.address)).to.equal(false);
    await access.connect(student).grantAccess(certId, verifier.address, (await time.latest()) + 100);
    await expect(access.connect(student).revokeAccess(certId, verifier.address))
      .to.emit(access, "AccessRevoked");
    await expect(access.connect(verifier).recordVerification(certId, HASH))
      .to.emit(access, "VerificationRecorded")
      .withArgs(certId, verifier.address, Status.Valid, anyUint());
  });

  it("anchors and verifies a standard Merkle batch", async function () {
    const { batch, certId, owner } = await loadFixture(deploy);
    const otherId = ethers.keccak256(ethers.toUtf8Bytes("other"));
    const tree = StandardMerkleTree.of([[certId, HASH], [otherId, OTHER_HASH]], ["bytes32", "bytes32"]);
    await expect(batch.anchorBatch(tree.root, 2, "June 2026")).to.emit(batch, "BatchAnchored");
    await expect(batch.anchorBatch(tree.root, 2, "duplicate"))
      .to.be.revertedWithCustomError(batch, "AlreadyAnchored");
    const proof = tree.getProof(0);
    expect(await batch.verifyInBatch(tree.root, proof, certId, HASH)).to.equal(Status.Valid);
    expect(await batch.verifyInBatch(tree.root, proof, certId, OTHER_HASH)).to.equal(Status.NotFound);
    expect(await batch.verifyInBatch(tree.root, [ethers.ZeroHash], certId, HASH)).to.equal(Status.NotFound);
    await expect(batch.revokeInBatch(tree.root, certId, "withdrawn"))
      .to.emit(batch, "BatchCertificateRevoked").withArgs(tree.root, certId, owner.address, "withdrawn");
    expect(await batch.verifyInBatch(tree.root, proof, certId, HASH)).to.equal(Status.Revoked);
  });

  it("runs the complete issuer, student, access and batch flow", async function () {
    const { institutions, registry, sbt, access, batch, institution, student, verifier, certId } =
      await loadFixture(deploy);
    await institutions.addInstitution(institution.address, "Partner");
    const second = await registry.computeCertId("S2", "B.Tech", "2026-01-02");
    await registry.connect(institution).issueCertificate(certId, CID, HASH, student.address);
    await access.connect(student).grantAccess(certId, verifier.address, (await time.latest()) + 1000);
    expect(await access.hasAccess(certId, verifier.address)).to.equal(true);
    const tree = StandardMerkleTree.of([[second, OTHER_HASH]], ["bytes32", "bytes32"]);
    await batch.connect(institution).anchorBatch(tree.root, 1, "partner");
    expect(await batch.verifyInBatch(tree.root, tree.getProof(0), second, OTHER_HASH)).to.equal(Status.Valid);
    expect(await sbt.balanceOf(student.address)).to.equal(1n);
  });
});

function anyUint() {
  return (value) => value > 0n;
}
