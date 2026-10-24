// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ICertOwner {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface ICertVerifier {
    struct Cert {
        string cid;
        bytes32 dataHash;
        address issuer;
        uint64 issuedAt;
        uint64 revokedAt;
    }

    function verifyCertificate(bytes32 certId, bytes32 dataHash)
        external
        view
        returns (uint8, Cert memory);
}

contract AccessManager {
    ICertVerifier public immutable certRegistry;
    ICertOwner public immutable sbt;
    mapping(bytes32 => mapping(address => uint256)) private _expiry;

    error NotCertificateOwner();
    error ZeroAddress();

    event AccessGranted(bytes32 indexed certId, address indexed verifier, uint256 expiresAt);
    event AccessRevoked(bytes32 indexed certId, address indexed verifier);
    event VerificationRecorded(bytes32 indexed certId, address indexed verifier, uint8 status, uint256 timestamp);

    constructor(address registry, address certificateSbt) {
        certRegistry = ICertVerifier(registry);
        sbt = ICertOwner(certificateSbt);
    }

    function grantAccess(bytes32 certId, address verifier, uint256 expiresAt) external {
        if (verifier == address(0)) revert ZeroAddress();
        if (sbt.ownerOf(uint256(certId)) != msg.sender) revert NotCertificateOwner();
        _expiry[certId][verifier] = expiresAt;
        emit AccessGranted(certId, verifier, expiresAt);
    }

    function revokeAccess(bytes32 certId, address verifier) external {
        if (sbt.ownerOf(uint256(certId)) != msg.sender) revert NotCertificateOwner();
        delete _expiry[certId][verifier];
        emit AccessRevoked(certId, verifier);
    }

    function hasAccess(bytes32 certId, address verifier) external view returns (bool) {
        return _expiry[certId][verifier] >= block.timestamp && _expiry[certId][verifier] != 0;
    }

    // Access is advisory: the decryption key remains off-chain.
    function recordVerification(bytes32 certId, bytes32 dataHash) external {
        (uint8 status,) = certRegistry.verifyCertificate(certId, dataHash);
        emit VerificationRecorded(certId, msg.sender, status, block.timestamp);
    }
}
