// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// Zama fhEVM — encrypted types and coprocessor config.
import {FHE, externalEuint64, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

// OpenZeppelin standard interfaces used in override lists.
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

// OpenZeppelin Confidential Contracts — ERC-7984 base and extensions.
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {IERC7984Rwa} from "@openzeppelin/confidential-contracts/interfaces/IERC7984Rwa.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {
    ERC7984ObserverAccess
} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ObserverAccess.sol";
import {
    ERC7984Rwa
} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984Rwa.sol";
import {
    ERC7984Restricted
} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984Restricted.sol";
import {
    ERC7984Freezable
} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984Freezable.sol";
import {
    ERC7984ERC20Wrapper
} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";

/**
 * @title ConfidentialEUR (cEUR)
 * @notice ERC-7984 confidential stablecoin built on Zama's fhEVM, implemented
 *         as a lock-and-mint wrapper around Circle's EURC.
 *
 * @dev The direct parent order is load-bearing: Solidity's C3 linearisation turns
 *      `super._update()` into a seven-step inherited compliance pipeline, capped
 *      by an eighth step in cEUR's own `_update` and `_forceUpdate` overrides.
 *      Reordering the parents silently reorders the checks.
 *
 *      Linearised MRO (most derived → most base):
 *          cEUR → Wrapper → Rwa → ObserverAccess → Restricted → Freezable → ERC7984
 *
 *      Pipeline walked by a single `super._update()` call:
 *        1. Wrapper         — total-supply cap (mint only)
 *        2. Rwa             — `whenNotPaused`
 *        3. ObserverAccess  — enter pipeline
 *        4. Restricted      — allowlist check, reverts if `from`/`to` != ALLOWED
 *        5. Freezable       — homomorphic available-balance cap (silent failure)
 *        6. ERC7984         — encrypted balance update + ACL + event
 *        7. ObserverAccess  — post-super user-observer ACL grant
 *        8. cEUR            — post-super regulatory-observer ACL grant
 *                              (fires in both `_update` and `_forceUpdate` paths)
 */
contract ConfidentialEUR is ERC7984ObserverAccess, ERC7984Rwa, ERC7984ERC20Wrapper {
    
    error DirectMintDisabled();
    error DirectBurnDisabled();
    
    constructor(
        address admin,
        IERC20 underlyingEURC
    )
        ERC7984("Confidential EUR", "cEUR", "https://raw.githubusercontent.com/luk267/ceur-poc/main/docs/metadata.json")
        ERC7984Rwa(admin)
        ERC7984ERC20Wrapper(underlyingEURC)
    {
        // Required on every fhEVM contract; mock plugin wires it on Hardhat.
        FHE.setCoprocessor(ZamaConfig.getEthereumCoprocessorConfig());
    }

    // ─── KYC / Allowlist ─────────────────────────────────────────────────────
    //
    // The OpenZeppelin default treats `DEFAULT` as permitted (blocklist model).
    // A MiCAR-regulated stablecoin needs the inverse: participants must opt in.
    // Flipping the semantics in `isUserAllowed` propagates through every parent
    // that calls `_checkRestriction`, so no further overrides are required.
    //
    // `address(0)` is handled by the parent sender/recipient checks, so mint
    // (`from == 0`) and burn (`to == 0`) do not need special-casing here.

    function isUserAllowed(address account) public view override returns (bool) {
        return getRestriction(account) == ERC7984Restricted.Restriction.ALLOWED;
    }

    function approveUser(address account) external onlyAgent {
        _allowUser(account);
    }

    /// @dev Resets to DEFAULT (KYC expired). Distinct from `blockUser`, which
    ///      sets BLOCKED (sanctions). Re-onboarding trap: `unblockUser` also
    ///      lands on DEFAULT — unblocking is not re-approval, the user must
    ///      go through `approveUser` again.
    function revokeUser(address account) external onlyAgent {
        _resetUser(account);
    }

    // ─── Coverage invariant ──────────────────────────────────────
    //
    // Supply changes must go through wrap()/unwrap() so that every cEUR is
    // backed 1:1 by locked EURC. Disabling direct mint/burn eliminates any
    // code path that could create unbacked tokens.
    //
    // Both functions have two overloads (externalEuint64 vs. euint64) — all
    // four must revert, otherwise one variant becomes a bypass.

    function confidentialMint(address, externalEuint64, bytes calldata) public override onlyAgent returns (euint64) {
        revert DirectMintDisabled();
    }

    function confidentialMint(address, euint64) public override onlyAgent returns (euint64) {
        revert DirectMintDisabled();
    }

    function confidentialBurn(address, externalEuint64, bytes calldata) public override onlyAgent returns (euint64) {
        revert DirectBurnDisabled();
    }

    function confidentialBurn(address, euint64) public override onlyAgent returns (euint64) {
        revert DirectBurnDisabled();
    }

    // ─── Regulatory observer (M7) ────────────────────────────────────────────
    //
    // Parallel to OZ's user-controlled `setObserver`/`observer`, this slot
    // holds an agent-appointed regulator that the account holder cannot
    // abdicate. Both mechanisms compose orthogonally — the `_update` hook
    // refreshes user-observer and regulator ACLs on the same new handle.
    // MiCAR-style mandatory oversight without taking the user's own auditor
    // away.

    mapping(address account => address) private _regulatoryObservers;

    event RegulatoryObserverSet(
        address indexed account,
        address indexed oldRegulator,
        address indexed newRegulator
    );

    function regulatoryObserver(address account) public view returns (address) {
        return _regulatoryObservers[account];
    }

    function setRegulatoryObserver(address account, address regulator) external onlyAgent {
        address oldRegulator = _regulatoryObservers[account];
        _regulatoryObservers[account] = regulator;
        emit RegulatoryObserverSet(account, oldRegulator, regulator);

        if (regulator != address(0)) {
            euint64 balanceHandle = confidentialBalanceOf(account);
            if (FHE.isInitialized(balanceHandle)) {
                FHE.allow(balanceHandle, regulator);
            }
        }
    }

    // ─── Required multi-inheritance overrides ────────────────────────────────

    /// @dev Single entry point for every mint, burn, transfer, wrap and unwrap.
    ///      The `super` call walks the C3-linearised parent chain and activates
    ///      the inherited seven-step compliance pipeline documented in the
    ///      contract-level NatSpec above. The trailing block grants
    ///      regulatory-observer ACLs on the freshly produced balance and
    ///      transferred handles — step 8 of the pipeline.
    function _update(
        address from,
        address to,
        euint64 amount
    )
        internal
        override(ERC7984ObserverAccess, ERC7984Rwa, ERC7984ERC20Wrapper)
        returns (euint64 transferred)
    {
        transferred = super._update(from, to, amount);
        _grantRegulatoryAccess(from, to, transferred);
    }

    /// @dev Force-transfer-path regulatory-observer refresh. `ERC7984Rwa._forceUpdate`
    ///      calls `super._update` from Rwa's MRO position, which intentionally skips
    ///      Wrapper-cap (stage 1) and `whenNotPaused` (stage 2) — the M6 bypass
    ///      matrix. The same C3 jump also skips `cEUR._update` (this class is
    ///      most-derived, above Rwa in the MRO), so without this override the
    ///      regulatory-observer ACL grant would silently miss every force
    ///      transfer. Reusing `_grantRegulatoryAccess` keeps step 8 of the
    ///      pipeline symmetric across the normal and force paths.
    function _forceUpdate(
        address from,
        address to,
        euint64 encryptedAmount
    )
        internal
        override
        returns (euint64 transferred)
    {
        transferred = super._forceUpdate(from, to, encryptedAmount);
        _grantRegulatoryAccess(from, to, transferred);
    }

    /// @dev Grants regulatory-observer ACL on the freshly produced balance and
    ///      transferred handles for both transfer sides. Called from both
    ///      `_update` (normal path) and `_forceUpdate` (force path) — same body,
    ///      two entry points, structurally guaranteed path symmetry.
    function _grantRegulatoryAccess(address from, address to, euint64 transferred) private {
        if (from != address(0)) {
            address fromRegulator = _regulatoryObservers[from];
            if (fromRegulator != address(0)) {
                FHE.allow(confidentialBalanceOf(from), fromRegulator);
                FHE.allow(transferred, fromRegulator);
            }
        }
        if (to != address(0)) {
            address toRegulator = _regulatoryObservers[to];
            if (toRegulator != address(0)) {
                FHE.allow(confidentialBalanceOf(to), toRegulator);
                FHE.allow(transferred, toRegulator);
            }
        }
    }


    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC7984, ERC7984Rwa) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    /// @dev Six decimals for EURC parity. Kept `view` because `IERC7984`
    ///      declares it `view` — an override cannot strengthen mutability.
    function decimals()
        public
        view
        override(ERC7984, ERC7984ERC20Wrapper, IERC7984)
        returns (uint8)
    {
        return 6;
    }
}
