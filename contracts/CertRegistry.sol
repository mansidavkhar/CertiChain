// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title CertRegistry
 * @notice On-chain registry of academic certificates for the IPFS + blockchain
 *         framework of Sultana et al., "IPFS-Blockchain Smart Contracts Based
 *         Conceptual Framework to Reduce Certificate Frauds in the Academic
 *         Field", Information 14(8):446, 2023 (MDPI, CC BY).
 *
 * @dev Design notes (deviations from the paper are deliberate and documented
 *      in docs/PLAN.md):
 *
 *      - The certificate payload itself NEVER touches the chain. It is
 *        encrypted off-chain, pushed to IPFS, and only the CID plus a keccak256
 *        digest of the exact ciphertext bytes are stored here. This is the
 *        paper's core idea: "the data that are stored in the blockchain are
 *        unique identifiers of the encrypted data".
 *
 *      - The paper authenticates the admin with a name/password integrity
 *        check against a local database. That is replaced here by on-chain
 *        role checks: only a whitelisted issuer address may issue or revoke.
 *        An attacker cannot forge a signature over someone else's address, so
 *        this is strictly stronger than a password check and costs no gas to
 *        read.
 *
 *      - verifyCertificate() is a `view` function so any employer can call it
 *        for free through a public RPC, with no wallet and no ETH balance.
 *        The paper gates viewing behind an ETH balance threshold; charging for
 *        verification would defeat the purpose of a public trust anchor.
 */
contract CertRegistry {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice Result of a verification attempt.
    enum Status {
        NotFound, // no certificate with this id was ever issued
        Valid, // issued, not revoked, and the supplied digest matches
        Tampered, // issued, but the supplied digest does not match
        Revoked // issued and digest matches, but later revoked
    }

    /**
     * @param cid        IPFS content identifier of the encrypted certificate.
     * @param dataHash   keccak256 of the raw ciphertext bytes stored at `cid`.
     * @param issuer     Address that called issueCertificate.
     * @param issuedAt   Block timestamp of issuance.
     * @param revokedAt  Block timestamp of revocation, 0 while still valid.
     */
    struct Cert {
        string cid;
        bytes32 dataHash;
        address issuer;
        uint64 issuedAt;
        uint64 revokedAt;
    }

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Contract owner; the only account that can manage issuers.
    address public owner;

    /// @notice Whitelisted issuing authorities (universities, exam boards).
    mapping(address => bool) public isIssuer;

    /// @notice certId => certificate record.
    mapping(bytes32 => Cert) private _certs;

    /// @notice Number of certificates issued so far (the paper's counter).
    uint256 public totalIssued;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event IssuerAdded(address indexed account);
    event IssuerRemoved(address indexed account);
    event OwnershipTransferred(address indexed from, address indexed to);

    event CertificateIssued(
        bytes32 indexed certId,
        address indexed issuer,
        string cid,
        bytes32 dataHash,
        uint64 issuedAt
    );

    event CertificateRevoked(
        bytes32 indexed certId,
        address indexed issuer,
        string reason,
        uint64 revokedAt
    );

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotOwner();
    error NotIssuer();
    error ZeroAddress();
    error EmptyCid();
    error ZeroHash();
    error ZeroCertId();
    error AlreadyIssued(bytes32 certId);
    error UnknownCertificate(bytes32 certId);
    error AlreadyRevoked(bytes32 certId);

    /*//////////////////////////////////////////////////////////////
                                MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyIssuer() {
        if (!isIssuer[msg.sender]) revert NotIssuer();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Deployer becomes owner and the first issuer.
    constructor() {
        owner = msg.sender;
        isIssuer[msg.sender] = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit IssuerAdded(msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                             ADMIN FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function addIssuer(address account) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        if (isIssuer[account]) return; // idempotent, no event spam
        isIssuer[account] = true;
        emit IssuerAdded(account);
    }

    function removeIssuer(address account) external onlyOwner {
        if (!isIssuer[account]) return;
        isIssuer[account] = false;
        emit IssuerRemoved(account);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }

    /*//////////////////////////////////////////////////////////////
                          CERTIFICATE LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Anchor a new certificate. This is the paper's `issue()`.
     * @param certId    Caller-computed id, normally
     *                  keccak256(abi.encode(studentId, course, issueDate)).
     *                  Computing it off-chain keeps the student's identifiers
     *                  off the public chain while staying deterministic.
     * @param cid       IPFS CID of the encrypted certificate.
     * @param dataHash  keccak256 of the ciphertext bytes stored at `cid`.
     */
    function issueCertificate(
        bytes32 certId,
        string calldata cid,
        bytes32 dataHash
    ) external onlyIssuer {
        if (certId == bytes32(0)) revert ZeroCertId();
        if (bytes(cid).length == 0) revert EmptyCid();
        if (dataHash == bytes32(0)) revert ZeroHash();
        if (_certs[certId].issuedAt != 0) revert AlreadyIssued(certId);

        uint64 ts = uint64(block.timestamp);
        _certs[certId] = Cert({
            cid: cid,
            dataHash: dataHash,
            issuer: msg.sender,
            issuedAt: ts,
            revokedAt: 0
        });

        unchecked {
            ++totalIssued;
        }

        emit CertificateIssued(certId, msg.sender, cid, dataHash, ts);
    }

    /**
     * @notice Revoke a certificate. This is the paper's `revoke()`.
     * @dev Only the original issuer may revoke, so one university cannot
     *      invalidate another's degrees. The record is kept, never deleted:
     *      an employer must still be able to see that the certificate existed
     *      and was withdrawn.
     */
    function revokeCertificate(
        bytes32 certId,
        string calldata reason
    ) external onlyIssuer {
        Cert storage c = _certs[certId];
        if (c.issuedAt == 0) revert UnknownCertificate(certId);
        if (c.issuer != msg.sender) revert NotIssuer();
        if (c.revokedAt != 0) revert AlreadyRevoked(certId);

        uint64 ts = uint64(block.timestamp);
        c.revokedAt = ts;

        emit CertificateRevoked(certId, msg.sender, reason, ts);
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW / VERIFICATION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Verify a certificate. This is the paper's `verify()`.
     * @dev Free to call: the verifier downloads the ciphertext from IPFS,
     *      hashes it locally, and passes the digest here. A mismatch means
     *      the off-chain file was altered after issuance.
     * @return status Outcome of the check.
     * @return cert   The stored record (zeroed when status is NotFound).
     */
    function verifyCertificate(
        bytes32 certId,
        bytes32 dataHash
    ) external view returns (Status status, Cert memory cert) {
        cert = _certs[certId];

        if (cert.issuedAt == 0) return (Status.NotFound, cert);
        if (cert.dataHash != dataHash) return (Status.Tampered, cert);
        if (cert.revokedAt != 0) return (Status.Revoked, cert);
        return (Status.Valid, cert);
    }

    /// @notice Read a record without supplying a digest. The paper's `view()`.
    function getCertificate(
        bytes32 certId
    ) external view returns (Cert memory) {
        Cert memory c = _certs[certId];
        if (c.issuedAt == 0) revert UnknownCertificate(certId);
        return c;
    }

    /// @notice True if the certificate exists and has not been revoked.
    function isValid(bytes32 certId) external view returns (bool) {
        Cert storage c = _certs[certId];
        return c.issuedAt != 0 && c.revokedAt == 0;
    }

    /**
     * @notice Helper so the dApp and the tests derive certIds identically.
     * @dev Pure, so it costs nothing and can be called off-chain.
     */
    function computeCertId(
        string calldata studentId,
        string calldata course,
        string calldata issueDate
    ) external pure returns (bytes32) {
        return keccak256(abi.encode(studentId, course, issueDate));
    }
}
