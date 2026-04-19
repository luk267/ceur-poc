import hre from "hardhat";
import { ethers } from "hardhat";
import { expect } from "chai";
import "@nomicfoundation/hardhat-chai-matchers";
import { FhevmType } from "@fhevm/mock-utils";

/**
 * Deploys MockEURC + ConfidentialEUR, grants AGENT_ROLE, and registers the
 * contract with the fhEVM mock coprocessor. Every test that touches encrypted
 * state needs `assertCoprocessorInitialized`, otherwise FHE ops revert.
 */
async function deployFixture() {
    const [admin, agent, user1, outsider] = await ethers.getSigners();

    const MockEURC = await ethers.getContractFactory("MockEURC");
    const eurc = await MockEURC.deploy();
    await eurc.waitForDeployment();

    const ConfidentialEUR = await ethers.getContractFactory("ConfidentialEUR");
    const ceur = await ConfidentialEUR.connect(admin).deploy(
        admin.address,
        await eurc.getAddress()
    );
    await ceur.waitForDeployment();

    await ceur.connect(admin).addAgent(agent.address);
    await hre.fhevm.assertCoprocessorInitialized(ceur, "ConfidentialEUR");

    return { ceur, eurc, admin, agent, user1, outsider };
}

describe("ConfidentialEUR", function () {
    describe("Deployment", function () {
        let ceur: any;
        let eurc: any;
        let admin: any;

        before(async function () {
            ({ ceur, eurc, admin } = await deployFixture());
        });

        it("has the correct name", async function () {
            expect(await ceur.name()).to.equal("Confidential EUR");
        });

        it("has the correct symbol", async function () {
            expect(await ceur.symbol()).to.equal("cEUR");
        });

        it("has 6 decimals", async function () {
            expect(await ceur.decimals()).to.equal(6n);
        });

        it("grants DEFAULT_ADMIN_ROLE to the admin", async function () {
            const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
            expect(await ceur.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
        });

        it("stores the correct underlying token", async function () {
            expect(await ceur.underlying()).to.equal(await eurc.getAddress());
        });
    });

    /**
     * KYC / Allowlist. Each test uses `beforeEach` because `approveUser`
     * mutates the restriction mapping and state must not leak between tests.
     */
    describe("KYC / Allowlist", function () {
        let ceur: any;
        let agent: any;
        let user1: any;
        let outsider: any;

        beforeEach(async function () {
            ({ ceur, agent, user1, outsider } = await deployFixture());
        });

        it("approveUser enables isUserAllowed", async function () {
            await ceur.connect(agent).approveUser(user1.address);
            expect(await ceur.isUserAllowed(user1.address)).to.be.true;
        });

        it("revokeUser disables isUserAllowed", async function () {
            await ceur.connect(agent).approveUser(user1.address);
            await ceur.connect(agent).revokeUser(user1.address);
            expect(await ceur.isUserAllowed(user1.address)).to.be.false;
        });

        it("a fresh user defaults to not allowed", async function () {
            expect(await ceur.isUserAllowed(user1.address)).to.be.false;
        });

        it("blockUser disables isUserAllowed", async function () {
            await ceur.connect(agent).approveUser(user1.address);
            await ceur.connect(agent).blockUser(user1.address);
            expect(await ceur.isUserAllowed(user1.address)).to.be.false;
        });

        // Re-onboarding trap: unblockUser lands on DEFAULT, not ALLOWED —
        // a previously blocked user must go through approveUser again.
        it("unblockUser leaves the user at DEFAULT, not ALLOWED", async function () {
            await ceur.connect(agent).approveUser(user1.address);
            await ceur.connect(agent).blockUser(user1.address);
            await ceur.connect(agent).unblockUser(user1.address);
            expect(await ceur.isUserAllowed(user1.address)).to.be.false;
        });

        it("outsiders cannot call approveUser", async function () {
            await expect(
                ceur.connect(outsider).approveUser(user1.address)
            ).to.be.revertedWithCustomError(ceur, "AccessControlUnauthorizedAccount");
        });
    });

    describe("Coverage invariant (ADR-008)", function () {
        let ceur: any;
        let agent: any;
        let user1: any;

        before(async function () {
            ({ ceur, agent, user1 } = await deployFixture());
        });

        it("confidentialMint(address,externalEuint64,bytes) reverts", async function () {
            await expect(
                ceur.connect(agent)["confidentialMint(address,bytes32,bytes)"](user1.address, ethers.ZeroHash, "0x")
            ).to.be.revertedWithCustomError(ceur, "DirectMintDisabled");
        });

        it("confidentialMint(address,euint64) reverts", async function () {
            await expect(
                ceur.connect(agent)["confidentialMint(address,bytes32)"](user1.address, ethers.ZeroHash)
            ).to.be.revertedWithCustomError(ceur, "DirectMintDisabled");
        });

        it("confidentialBurn(address,externalEuint64,bytes) reverts", async function () {
            await expect(
                ceur.connect(agent)["confidentialBurn(address,bytes32,bytes)"](user1.address, ethers.ZeroHash, "0x")
            ).to.be.revertedWithCustomError(ceur, "DirectBurnDisabled");
        });

        it("confidentialBurn(address,euint64) reverts", async function () {
            await expect(
                ceur.connect(agent)["confidentialBurn(address,bytes32)"](user1.address, ethers.ZeroHash)
            ).to.be.revertedWithCustomError(ceur, "DirectBurnDisabled");
        });
       
    });

    describe("Wrap flow (M4)", function () {
        let ceur: any;
        let eurc: any;
        let agent: any;
        let user1: any;

        const AMOUNT = 1000_000_000n; // 1000 EURC (6 decimals)

        beforeEach(async function () {
            ({ ceur, eurc, agent, user1 } = await deployFixture());
        });

        it("wraps EURC into encrypted cEUR", async function () {
            // Setup: mint EURC, approve cEUR contract, KYC
            await eurc.connect(user1).mint(user1.address, AMOUNT);
            await eurc.connect(user1).approve(await ceur.getAddress(), AMOUNT);
            await ceur.connect(agent).approveUser(user1.address);

            // Act
            await ceur.connect(user1).wrap(user1.address, AMOUNT);

            // Assert: EURC locked in contract
            expect(await eurc.balanceOf(await ceur.getAddress())).to.equal(AMOUNT);
            expect(await eurc.balanceOf(user1.address)).to.equal(0n);

            // Assert: encrypted cEUR balance matches
            const handle = await ceur.confidentialBalanceOf(user1.address);
            const balance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64,
                handle,
                await ceur.getAddress(),
                user1
            );
            expect(balance).to.equal(AMOUNT);
        });

        it("reverts without EURC approve", async function () {
            await eurc.connect(user1).mint(user1.address, AMOUNT);
            // no approve!
            await ceur.connect(agent).approveUser(user1.address);

            await expect(
                ceur.connect(user1).wrap(user1.address, AMOUNT)
            ).to.be.reverted;
        });

        it("reverts without KYC", async function () {
            await eurc.connect(user1).mint(user1.address, AMOUNT);
            await eurc.connect(user1).approve(await ceur.getAddress(), AMOUNT);
            // no approveUser!

            await expect(
                ceur.connect(user1).wrap(user1.address, AMOUNT)
            ).to.be.revertedWithCustomError(ceur, "UserRestricted");
        });

        it("maintains the coverage invariant after wrap", async function () {
            await eurc.connect(user1).mint(user1.address, AMOUNT);
            await eurc.connect(user1).approve(await ceur.getAddress(), AMOUNT);
            await ceur.connect(agent).approveUser(user1.address);

            await ceur.connect(user1).wrap(user1.address, AMOUNT);

            // EURC locked in contract >= inferredTotalSupply (publicly verifiable)
            const locked = await eurc.balanceOf(await ceur.getAddress());
            const inferred = await ceur.inferredTotalSupply();
            expect(locked).to.be.greaterThanOrEqual(inferred);
        });
    });

    describe("Unwrap flow (M4)", function () {
        let ceur: any;
        let eurc: any;
        let agent: any;
        let user1: any;

        const AMOUNT = 1000_000_000n;

        beforeEach(async function () {
            ({ ceur, eurc, agent, user1 } = await deployFixture());

            // Wrap setup: every unwrap test starts with wrapped cEUR
            await eurc.connect(user1).mint(user1.address, AMOUNT);
            await eurc.connect(user1).approve(await ceur.getAddress(), AMOUNT);
            await ceur.connect(agent).approveUser(user1.address);
            await ceur.connect(user1).wrap(user1.address, AMOUNT);
        });

        it("unwrap + finalizeUnwrap returns EURC to the user", async function () {
            // Step 1: get the encrypted balance handle for unwrap
            const balanceHandle = await ceur.confidentialBalanceOf(user1.address);

            // Step 2: unwrap — burns cEUR, emits UnwrapRequested
            const tx = await ceur.connect(user1).unwrap(user1.address, user1.address, balanceHandle);
            const receipt = await tx.wait();

            // Step 3: extract burntAmount handle from UnwrapRequested event
            const unwrapEvent = receipt.logs.find(
                (log: any) => ceur.interface.parseLog(log)?.name === "UnwrapRequested"
            );
            const parsed = ceur.interface.parseLog(unwrapEvent);
            const burntAmountHandle = parsed.args.amount;

            // Step 4: get decryption proof from mock
            const decryptionResult = await hre.fhevm.publicDecrypt([burntAmountHandle]);
            const cleartext = decryptionResult.clearValues[burntAmountHandle];
            const proof = decryptionResult.decryptionProof;

            // Step 5: finalize — verifies proof, releases EURC
            await ceur.finalizeUnwrap(burntAmountHandle, cleartext, proof);

            // Assert: EURC returned to user
            expect(await eurc.balanceOf(user1.address)).to.equal(AMOUNT);
            expect(await eurc.balanceOf(await ceur.getAddress())).to.equal(0n);
        });

        it("double finalizeUnwrap reverts", async function () {
            const balanceHandle = await ceur.confidentialBalanceOf(user1.address);
            const tx = await ceur.connect(user1).unwrap(user1.address, user1.address, balanceHandle);
            const receipt = await tx.wait();

            const unwrapEvent = receipt.logs.find(
                (log: any) => ceur.interface.parseLog(log)?.name === "UnwrapRequested"
            );
            const parsed = ceur.interface.parseLog(unwrapEvent);
            const burntAmountHandle = parsed.args.amount;

            const decryptionResult = await hre.fhevm.publicDecrypt([burntAmountHandle]);
            const cleartext = decryptionResult.clearValues[burntAmountHandle];
            const proof = decryptionResult.decryptionProof;

            // First finalize succeeds
            await ceur.finalizeUnwrap(burntAmountHandle, cleartext, proof);

            // Second finalize reverts — request already deleted
            await expect(
                ceur.finalizeUnwrap(burntAmountHandle, cleartext, proof)
            ).to.be.revertedWithCustomError(ceur, "InvalidUnwrapRequest");
        });

        it("unwrap reverts without KYC", async function () {
            // Revoke KYC after wrap
            await ceur.connect(agent).revokeUser(user1.address);

            const balanceHandle = await ceur.confidentialBalanceOf(user1.address);

            await expect(
                ceur.connect(user1).unwrap(user1.address, user1.address, balanceHandle)
            ).to.be.revertedWithCustomError(ceur, "UserRestricted");
        });
    });




});
