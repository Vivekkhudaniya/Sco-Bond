// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.17;

/// @dev Test-only ONCHAINID stand-in: IdentityRegistry.isVerified only needs getClaim().
contract MockIdentityForIR {
    struct Claim { uint256 topic; address issuer; bytes sig; bytes data; }
    mapping(bytes32 => Claim) public claims;

    function setClaim(address issuer, uint256 topic) external {
        claims[keccak256(abi.encode(issuer, topic))] = Claim(topic, issuer, hex"01", hex"02");
    }

    function getClaim(bytes32 id) external view returns (
        uint256, uint256, address, bytes memory, bytes memory, string memory
    ) {
        Claim memory c = claims[id];
        return (c.topic, 1, c.issuer, c.sig, c.data, "");
    }
}

/// @dev Test-only claim issuer: validity can be switched, or the call can be made to revert.
contract MockClaimIssuerForIR {
    bool public valid = true;
    bool public shouldRevert;

    function setValid(bool v) external { valid = v; }
    function setRevert(bool r) external { shouldRevert = r; }

    function isClaimValid(address, uint256, bytes calldata, bytes calldata) external view returns (bool) {
        if (shouldRevert) revert("issuer reverted");
        return valid;
    }
}
