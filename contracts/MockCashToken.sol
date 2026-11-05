// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract MockCashToken is ERC20, Ownable {
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    constructor() ERC20("Euro Digital", "EURd") {}

    function mint(address _to, uint256 _amount) external onlyOwner {
        _mint(_to, _amount);
    }
}
