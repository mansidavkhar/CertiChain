// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

interface IBatchInstitutionRegistry {
    function isApproved(address institution) external view returns (bool);
}

interface IBatchCertRegistry {
    function verifyCertificate(bytes32 certId, bytes32 dataHash) external view returns (uint8, bytes memory);
}

contract BatchRegistry {
    enum Status { NotFound, Valid, Tampered, Revoked }
    struct Batch { address issuer; uint64 anchoredAt; uint32 count; string label; }

    IBatchInstitutionRegistry public immutable institutionRegistry;
    IBatchCertRegistry public immutable certRegistry;
    mapping(bytes32 => Batch) public batches;
    mapping(bytes32 => mapping(bytes32 => bool)) public revoked;

    error NotIssuer();
    error AlreadyAnchored(bytes32 root);
    error UnknownBatch(bytes32 root);
    error NotBatchIssuer();

    event BatchAnchored(bytes32 indexed root, address indexed issuer, uint32 count, string label, uint64 timestamp);
    event BatchCertificateRevoked(bytes32 indexed root, bytes32 indexed certId, address indexed issuer, string reason);

    constructor(address institution) {
        institutionRegistry = IBatchInstitutionRegistry(institution);
        certRegistry = IBatchCertRegistry(address(0));
    }

    function anchorBatch(bytes32 root, uint32 count, string calldata label) external {
        if (!institutionRegistry.isApproved(msg.sender)) revert NotIssuer();
        if (batches[root].anchoredAt != 0) revert AlreadyAnchored(root);
        batches[root] = Batch(msg.sender, uint64(block.timestamp), count, label);
        emit BatchAnchored(root, msg.sender, count, label, uint64(block.timestamp));
    }

    function verifyInBatch(bytes32 root, bytes32[] calldata proof, bytes32 certId, bytes32 dataHash)
        external
        view
        returns (Status)
    {
        Batch memory batch = batches[root];
        if (batch.anchoredAt == 0) return Status.NotFound;
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(certId, dataHash))));
        if (!MerkleProof.verify(proof, root, leaf)) return Status.NotFound;
        if (revoked[root][certId]) return Status.Revoked;
        return Status.Valid;
    }

    function revokeInBatch(bytes32 root, bytes32 certId, string calldata reason) external {
        Batch memory batch = batches[root];
        if (batch.anchoredAt == 0) revert UnknownBatch(root);
        if (batch.issuer != msg.sender) revert NotBatchIssuer();
        revoked[root][certId] = true;
        emit BatchCertificateRevoked(root, certId, msg.sender, reason);
    }
}
