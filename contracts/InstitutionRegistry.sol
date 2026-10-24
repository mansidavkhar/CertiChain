// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract InstitutionRegistry {
    address public owner;
    mapping(address => bool) private _approved;
    mapping(address => string) private _names;

    error NotOwner();
    error ZeroAddress();

    event OwnershipTransferred(address indexed from, address indexed to);
    event InstitutionAdded(address indexed institution, string name);
    event InstitutionRemoved(address indexed institution);

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function addInstitution(address institution, string calldata name) external onlyOwner {
        if (institution == address(0)) revert ZeroAddress();
        _approved[institution] = true;
        _names[institution] = name;
        emit InstitutionAdded(institution, name);
    }

    function removeInstitution(address institution) external onlyOwner {
        _approved[institution] = false;
        delete _names[institution];
        emit InstitutionRemoved(institution);
    }

    function isApproved(address institution) external view returns (bool) {
        return _approved[institution];
    }

    function getName(address institution) external view returns (string memory) {
        return _names[institution];
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }
}
