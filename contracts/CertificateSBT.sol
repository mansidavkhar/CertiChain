// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract CertificateSBT is ERC721Enumerable {
    address public owner;
    address public minter;
    mapping(uint256 => string) private _cids;

    error NotOwner();
    error NotMinter();
    error ZeroAddress();
    error MinterAlreadySet();
    error Soulbound();

    event OwnershipTransferred(address indexed from, address indexed to);
    event MinterSet(address indexed minter);

    constructor() ERC721("CertChain Certificate", "CERT") {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter();
        _;
    }

    function setMinter(address newMinter) external onlyOwner {
        if (newMinter == address(0)) revert ZeroAddress();
        if (minter != address(0)) revert MinterAlreadySet();
        minter = newMinter;
        emit MinterSet(newMinter);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }

    function mint(address to, bytes32 certId, string calldata cid) external onlyMinter {
        if (to == address(0)) revert ZeroAddress();
        _safeMint(to, uint256(certId));
        _cids[uint256(certId)] = cid;
    }

    function burn(bytes32 certId) external onlyMinter {
        uint256 tokenId = uint256(certId);
        _burn(tokenId);
        delete _cids[tokenId];
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string.concat("ipfs://", _cids[tokenId]);
    }

    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721Enumerable)
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721Enumerable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
