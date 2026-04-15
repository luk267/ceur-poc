// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockEURC
 * @notice Test stand-in for Circle's EURC. Used only on local Hardhat networks;
 *         on Sepolia the real EURC contract is used.
 *
 * @dev Six decimals match EURC and keep the cEUR `euint64` balance headroom at
 *      ~18.4 trillion tokens. Eighteen decimals would cap `euint64` near 18 cEUR.
 */
contract MockEURC is ERC20 {
    constructor() ERC20("Euro Coin", "EURC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @dev Permissionless mint — do not deploy outside tests.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
