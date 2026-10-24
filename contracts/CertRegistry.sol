// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IInstitutionRegistry {
    function isApproved(address institution) external view returns (bool);
}

interface ICertificateSBT {
    function mint(address to, bytes32 certId, string calldata cid) external;
    function burn(bytes32 certId) external;
}

contract CertRegistry {
    enum Status { NotFound, Valid, Tampered, Revoked }

    struct Cert {
        string cid;
        bytes32 dataHash;
        address issuer;
        uint64 issuedAt;
        uint64 revokedAt;
    }

    IInstitutionRegistry public immutable institutionRegistry;
    ICertificateSBT public immutable sbt;
    mapping(bytes32 => Cert) private _certs;
    uint256 public totalIssued;

    event CertificateIssued(bytes32 indexed certId, address indexed issuer, string cid, bytes32 dataHash, uint64 issuedAt);
    event CertificateRevoked(bytes32 indexed certId, address indexed issuer, string reason, uint64 revokedAt);

    error NotIssuer();
    error EmptyCid();
    error ZeroHash();
    error ZeroCertId();
    error AlreadyIssued(bytes32 certId);
    error UnknownCertificate(bytes32 certId);
    error AlreadyRevoked(bytes32 certId);

    constructor(address institution, address certificateSbt) {
        institutionRegistry = IInstitutionRegistry(institution);
        sbt = ICertificateSBT(certificateSbt);
    }

    modifier onlyInstitution() {
        if (!institutionRegistry.isApproved(msg.sender)) revert NotIssuer();
        _;
    }

    function issueCertificate(bytes32 certId, string calldata cid, bytes32 dataHash, address student)
        external
        onlyInstitution
    {
        if (certId == bytes32(0)) revert ZeroCertId();
        if (bytes(cid).length == 0) revert EmptyCid();
        if (dataHash == bytes32(0)) revert ZeroHash();
        if (_certs[certId].issuedAt != 0) revert AlreadyIssued(certId);
        uint64 ts = uint64(block.timestamp);
        _certs[certId] = Cert(cid, dataHash, msg.sender, ts, 0);
        unchecked { ++totalIssued; }
        if (student != address(0)) sbt.mint(student, certId, cid);
        emit CertificateIssued(certId, msg.sender, cid, dataHash, ts);
    }

    function revokeCertificate(bytes32 certId, string calldata reason) external {
        Cert storage c = _certs[certId];
        if (c.issuedAt == 0) revert UnknownCertificate(certId);
        if (c.issuer != msg.sender) revert NotIssuer();
        if (c.revokedAt != 0) revert AlreadyRevoked(certId);
        c.revokedAt = uint64(block.timestamp);
        if (_existsInSbt(certId)) sbt.burn(certId);
        emit CertificateRevoked(certId, msg.sender, reason, c.revokedAt);
    }

    function _existsInSbt(bytes32 certId) private view returns (bool) {
        (bool ok, bytes memory data) = address(sbt).staticcall(
            abi.encodeWithSignature("ownerOf(uint256)", uint256(certId))
        );
        return ok && data.length >= 32;
    }

    function verifyCertificate(bytes32 certId, bytes32 dataHash)
        external
        view
        returns (Status status, Cert memory cert)
    {
        cert = _certs[certId];
        if (cert.issuedAt == 0) return (Status.NotFound, cert);
        if (cert.dataHash != dataHash) return (Status.Tampered, cert);
        if (cert.revokedAt != 0) return (Status.Revoked, cert);
        return (Status.Valid, cert);
    }

    function getCertificate(bytes32 certId) external view returns (Cert memory) {
        Cert memory c = _certs[certId];
        if (c.issuedAt == 0) revert UnknownCertificate(certId);
        return c;
    }

    function isValid(bytes32 certId) external view returns (bool) {
        return _certs[certId].issuedAt != 0 && _certs[certId].revokedAt == 0;
    }

    function computeCertId(string calldata studentId, string calldata course, string calldata issueDate)
        external
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(studentId, course, issueDate));
    }
}
