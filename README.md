# ceur-poc — Confidential EUR Stablecoin (PoC)

`ConfidentialEUR` (cEUR) is a lock-and-mint wrapper around Circle's EURC.
Balances and transfer amounts are stored and processed as encrypted
ciphertexts on Zama's fhEVM, so the on-chain history shows who transacted
with whom but not how much. It implements the ERC-7984 confidential token
standard and bundles a small compliance layer (KYC allowlist, freeze,
force-transfer, pause, observer access) on top.

The contract is the practical artefact of a Master's thesis:
**_Development and Evaluation of a Confidential Stablecoin using fhEVM for
Confidential B2B Payments._**

---

## Status

Phase 2 (implementation) — core contracts are feature-complete; integration
work and documentation are in progress. **Not audited, not for production
use.** Targets local Hardhat and Sepolia testnet.

---

## Quickstart

Requires Node.js ≥ 20.

```bash
npm install
npm run compile
npm test
npm run coverage
```

Linting and formatting:

```bash
npm run lint
npm run format
```

---

## Stack

| Component                              | Version   |
| -------------------------------------- | --------- |
| Solidity (cancun, optimizer 800)       | `0.8.27`  |
| Hardhat                                | `^2.28.6` |
| `@fhevm/solidity`                      | `^0.11.1` |
| `@fhevm/hardhat-plugin`                | `^0.4.2`  |
| `@openzeppelin/confidential-contracts` | `^0.3.1`  |
| `@openzeppelin/contracts`              | `^5.6.1`  |
| `ethers`                               | `^6.16.0` |

`@openzeppelin/confidential-contracts` provides the ERC-7984 base, the RWA
extension, the ERC-20 wrapper, the restricted/freezable/observer mixins, and
the operator pattern. `ConfidentialEUR` composes those mixins and adds
project-specific configuration (KYC semantics, disabled direct mint/burn,
six decimals to align with EURC).

---

## Architecture

`ConfidentialEUR` inherits from three OpenZeppelin mixins
(`ERC7984ObserverAccess`, `ERC7984Rwa`, `ERC7984ERC20Wrapper`). Solidity's C3
linearisation produces a deterministic seven-step compliance pipeline that
runs on every mint, burn, transfer, wrap and unwrap: supply cap, pause check,
observer entry, KYC allowlist, frozen-amount cap, encrypted balance update,
observer ACL.

`wrap` is synchronous (lock EURC, mint encrypted cEUR). `unwrap` is two-phase:
the cEUR amount is burnt immediately, the resulting handle is marked publicly
decryptable, and `finalizeUnwrap` releases the EURC once the cleartext and
decryption proof are returned.

The full breakdown — pipeline order, wrap/unwrap sequence diagrams, role
matrix, encrypted-type cheatsheet — lives in
[`docs/architecture.md`](docs/architecture.md).

---

## Tests & Coverage

The test suite covers the full lifecycle: KYC gating, wrap, unwrap (both
phases), confidential transfer, freeze and force-transfer, pause behaviour,
and the disabled direct-mint/burn paths.

```bash
npm test            # Hardhat + Mocha test suite
npm run coverage    # solidity-coverage
npm run lint        # solhint + eslint
```

---

## Repository layout

```
contracts/    ConfidentialEUR.sol, MockEURC.sol (local EURC stand-in)
test/         ConfidentialEUR.test.ts
docs/         architecture.md, metadata.json
```

---

## License

ISC. See [`LICENSE`](LICENSE).
