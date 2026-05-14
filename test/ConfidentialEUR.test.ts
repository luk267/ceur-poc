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
    const [admin, agent, user1, user2, user3, outsider, user4, user5] = await ethers.getSigners();

    const MockEURC = await ethers.getContractFactory("MockEURC");
    const eurc = await MockEURC.deploy();
    await eurc.waitForDeployment();

    const ConfidentialEUR = await ethers.getContractFactory("ConfidentialEUR");
    const ceur = await ConfidentialEUR.connect(admin).deploy(admin.address, await eurc.getAddress());
    await ceur.waitForDeployment();

    await ceur.connect(admin).addAgent(agent.address);
    await hre.fhevm.assertCoprocessorInitialized(ceur, "ConfidentialEUR");

    return { ceur, eurc, admin, agent, user1, user2, user3, user4, user5, outsider };
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
            await expect(ceur.connect(outsider).approveUser(user1.address)).to.be.revertedWithCustomError(
                ceur,
                "AccessControlUnauthorizedAccount",
            );
        });
    });

    describe("Coverage invariant", function () {
        let ceur: any;
        let agent: any;
        let user1: any;

        before(async function () {
            ({ ceur, agent, user1 } = await deployFixture());
        });

        it("confidentialMint(address,externalEuint64,bytes) reverts", async function () {
            await expect(
                ceur.connect(agent)["confidentialMint(address,bytes32,bytes)"](user1.address, ethers.ZeroHash, "0x"),
            ).to.be.revertedWithCustomError(ceur, "DirectMintDisabled");
        });

        it("confidentialMint(address,euint64) reverts", async function () {
            await expect(
                ceur.connect(agent)["confidentialMint(address,bytes32)"](user1.address, ethers.ZeroHash),
            ).to.be.revertedWithCustomError(ceur, "DirectMintDisabled");
        });

        it("confidentialBurn(address,externalEuint64,bytes) reverts", async function () {
            await expect(
                ceur.connect(agent)["confidentialBurn(address,bytes32,bytes)"](user1.address, ethers.ZeroHash, "0x"),
            ).to.be.revertedWithCustomError(ceur, "DirectBurnDisabled");
        });

        it("confidentialBurn(address,euint64) reverts", async function () {
            await expect(
                ceur.connect(agent)["confidentialBurn(address,bytes32)"](user1.address, ethers.ZeroHash),
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
            const balance = await hre.fhevm.userDecryptEuint(FhevmType.euint64, handle, await ceur.getAddress(), user1);
            expect(balance).to.equal(AMOUNT);
        });

        it("reverts without EURC approve", async function () {
            await eurc.connect(user1).mint(user1.address, AMOUNT);
            // no approve!
            await ceur.connect(agent).approveUser(user1.address);

            await expect(ceur.connect(user1).wrap(user1.address, AMOUNT)).to.be.reverted;
        });

        it("reverts without KYC", async function () {
            await eurc.connect(user1).mint(user1.address, AMOUNT);
            await eurc.connect(user1).approve(await ceur.getAddress(), AMOUNT);
            // no approveUser!

            await expect(ceur.connect(user1).wrap(user1.address, AMOUNT)).to.be.revertedWithCustomError(
                ceur,
                "UserRestricted",
            );
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
                (log: any) => ceur.interface.parseLog(log)?.name === "UnwrapRequested",
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
                (log: any) => ceur.interface.parseLog(log)?.name === "UnwrapRequested",
            );
            const parsed = ceur.interface.parseLog(unwrapEvent);
            const burntAmountHandle = parsed.args.amount;

            const decryptionResult = await hre.fhevm.publicDecrypt([burntAmountHandle]);
            const cleartext = decryptionResult.clearValues[burntAmountHandle];
            const proof = decryptionResult.decryptionProof;

            // First finalize succeeds
            await ceur.finalizeUnwrap(burntAmountHandle, cleartext, proof);

            // Second finalize reverts — request already deleted
            await expect(ceur.finalizeUnwrap(burntAmountHandle, cleartext, proof)).to.be.revertedWithCustomError(
                ceur,
                "InvalidUnwrapRequest",
            );
        });

        it("unwrap reverts without KYC", async function () {
            // Revoke KYC after wrap
            await ceur.connect(agent).revokeUser(user1.address);

            const balanceHandle = await ceur.confidentialBalanceOf(user1.address);

            await expect(
                ceur.connect(user1).unwrap(user1.address, user1.address, balanceHandle),
            ).to.be.revertedWithCustomError(ceur, "UserRestricted");
        });
    });

    describe("Confidential Transfer (M5)", function () {
        let ceur: any;
        let eurc: any;
        let agent: any;
        let alice: any; // = user1  (sender, will be pre-funded)
        let bob: any; // = user2  (receiver, starts at 0)
        let charlie: any; // = user3  (operator-transfer recipient, KYC'd)
        let outsider: any; // no KYC  (used in KYC-revert tests)

        const WRAP_AMOUNT = 1000_000_000n; // 1000 cEUR, Alice's starting balance
        const TRANSFER_AMOUNT = 500_000_000n; // 500 cEUR, default transfer size
        const OVERDRAFT_AMOUNT = 2000_000_000n; // 2000 cEUR, silent failure transfer size
        const FORWARD_AMOUNT = 600_000_000n; // Alice → Bob
        const BACKWARD_AMOUNT = 200_000_000n; // Bob → Alice

        beforeEach(async function () {
            ({ ceur, eurc, agent, user1: alice, user2: bob, user3: charlie, outsider } = await deployFixture());

            // KYC both happy-path users; `outsider` stays unapproved on purpose.
            await ceur.connect(agent).approveUser(alice.address);
            await ceur.connect(agent).approveUser(bob.address);
            await ceur.connect(agent).approveUser(charlie.address);

            // Pre-fund Alice via wrap so every transfer test starts from a known state.
            await eurc.connect(alice).mint(alice.address, WRAP_AMOUNT);
            await eurc.connect(alice).approve(await ceur.getAddress(), WRAP_AMOUNT);
            await ceur.connect(alice).wrap(alice.address, WRAP_AMOUNT);
        });

        it("happy path: alice to bob", async function () {
            // Alice encrypts 500 cEUR.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                TRANSFER_AMOUNT,
                await ceur.getAddress(),
                alice.address,
            );

            // Alice → Bob, 500 cEUR.
            await ceur
                .connect(alice)
                ["confidentialTransfer(address,bytes32,bytes)"](bob.address, enc.externalEuint, enc.inputProof);

            // Alice: 1000 - 500 = 500
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const aliceBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64,
                aliceHandle,
                await ceur.getAddress(),
                alice,
            );
            expect(aliceBalance).to.equal(WRAP_AMOUNT - TRANSFER_AMOUNT);

            // Bob: 0 + 500 = 500
            const bobHandle = await ceur.confidentialBalanceOf(bob.address);
            const bobBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64,
                bobHandle,
                await ceur.getAddress(),
                bob,
            );
            expect(bobBalance).to.equal(TRANSFER_AMOUNT);
        });

        it("silent failure: transfer exceeds balance", async function () {
            // Alice encrypts 2000 cEUR — more than her balance, will trigger silent failure.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                OVERDRAFT_AMOUNT,
                await ceur.getAddress(),
                alice.address,
            );

            // Alice → Bob, 2000 cEUR — pipeline runs but transferred = enc(0).
            await ceur
                .connect(alice)
                ["confidentialTransfer(address,bytes32,bytes)"](bob.address, enc.externalEuint, enc.inputProof);

            // Alice: 1000 (unchanged, FHE.select picked the no-op branch)
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const aliceBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64,
                aliceHandle,
                await ceur.getAddress(),
                alice,
            );
            expect(aliceBalance).to.equal(WRAP_AMOUNT);

            // Bob: 0 (silent failure → received nothing)
            const bobHandle = await ceur.confidentialBalanceOf(bob.address);
            const bobBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64,
                bobHandle,
                await ceur.getAddress(),
                bob,
            );
            expect(bobBalance).to.equal(0n);
        });

        it("transfer to self leaves balance unchanged", async function () {
            // Alice encrypts 500 cEUR.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                TRANSFER_AMOUNT,
                await ceur.getAddress(),
                alice.address,
            );

            // Alice → Alice, 500 cEUR — pipeline subtracts then re-adds, net zero.
            await ceur
                .connect(alice)
                ["confidentialTransfer(address,bytes32,bytes)"](alice.address, enc.externalEuint, enc.inputProof);

            // Alice: 1000 - 500 + 500 = 1000
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const aliceBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64,
                aliceHandle,
                await ceur.getAddress(),
                alice,
            );
            expect(aliceBalance).to.equal(WRAP_AMOUNT);
        });

        it("bidirectional transfers preserve total balance", async function () {
            // Alice encrypts 600 cEUR.
            const enc1 = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                FORWARD_AMOUNT,
                await ceur.getAddress(),
                alice.address,
            );

            // Alice → Bob, 600 cEUR.
            await ceur
                .connect(alice)
                ["confidentialTransfer(address,bytes32,bytes)"](bob.address, enc1.externalEuint, enc1.inputProof);

            // Bob encrypts 200 cEUR.
            const enc2 = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                BACKWARD_AMOUNT,
                await ceur.getAddress(),
                bob.address,
            );

            // Bob → Alice, 200 cEUR.
            await ceur
                .connect(bob)
                ["confidentialTransfer(address,bytes32,bytes)"](alice.address, enc2.externalEuint, enc2.inputProof);

            // Alice: 1000 - 600 + 200 = 600
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const aliceBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64,
                aliceHandle,
                await ceur.getAddress(),
                alice,
            );
            expect(aliceBalance).to.equal(WRAP_AMOUNT - FORWARD_AMOUNT + BACKWARD_AMOUNT);

            // Bob: 0 + 600 - 200 = 400
            const bobHandle = await ceur.confidentialBalanceOf(bob.address);
            const bobBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64,
                bobHandle,
                await ceur.getAddress(),
                bob,
            );
            expect(bobBalance).to.equal(FORWARD_AMOUNT - BACKWARD_AMOUNT);
        });

        it("reverts when sender is not KYC'd", async function () {
            // Revoke Alice's KYC after she has been pre-funded by the beforeEach.
            await ceur.connect(agent).revokeUser(alice.address);

            // Alice encrypts 500 cEUR.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                TRANSFER_AMOUNT,
                await ceur.getAddress(),
                alice.address,
            );

            // Pipeline reverts at the Restricted layer (stage 4) — Alice is no longer ALLOWED.
            await expect(
                ceur
                    .connect(alice)
                    ["confidentialTransfer(address,bytes32,bytes)"](bob.address, enc.externalEuint, enc.inputProof),
            ).to.be.revertedWithCustomError(ceur, "UserRestricted");
        });

        it("reverts when receiver is not KYC'd", async function () {
            // Alice encrypts 500 cEUR.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                TRANSFER_AMOUNT,
                await ceur.getAddress(),
                alice.address,
            );

            // Outsider was never approved — recipient-side KYC blocks the transfer.
            await expect(
                ceur
                    .connect(alice)
                    [
                        "confidentialTransfer(address,bytes32,bytes)"
                    ](outsider.address, enc.externalEuint, enc.inputProof),
            ).to.be.revertedWithCustomError(ceur, "UserRestricted");
        });

        it("operator transfers funds from holder to recipient", async function () {
            // Alice sets Bob as operator (time-bounded delegation, no amount cap).
            const FAR_FUTURE = 2n ** 47n - 1n;
            await ceur.connect(alice).setOperator(bob.address, FAR_FUTURE);

            // Bob encrypts 500 cEUR — proof binds to msg.sender (= Bob), not the holder.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                TRANSFER_AMOUNT,
                await ceur.getAddress(),
                bob.address,
            );

            // Bob (operator) moves Alice's funds to Charlie.
            await ceur
                .connect(bob)
                [
                    "confidentialTransferFrom(address,address,bytes32,bytes)"
                ](alice.address, charlie.address, enc.externalEuint, enc.inputProof);

            // Alice: 1000 - 500 = 500
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const aliceBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64,
                aliceHandle,
                await ceur.getAddress(),
                alice,
            );
            expect(aliceBalance).to.equal(WRAP_AMOUNT - TRANSFER_AMOUNT);

            // Charlie: 0 + 500 = 500
            const charlieHandle = await ceur.confidentialBalanceOf(charlie.address);
            const charlieBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64,
                charlieHandle,
                await ceur.getAddress(),
                charlie,
            );
            expect(charlieBalance).to.equal(TRANSFER_AMOUNT);
        });
    });


    describe("Compliance (M6)", function () {
        let ceur: any;
        let eurc: any;
        let agent: any;
        let alice: any;      // = user1  (sender, will be pre-funded)
        let bob: any;        // = user2  (receiver, starts at 0)
        let outsider: any;   // not KYC-approved — used to test receiver restriction

        const WRAP_AMOUNT = 1000_000_000n;      // 1000 cEUR, Alice's starting balance
        const TRANSFER_AMOUNT = 500_000_000n;   // 500 cEUR, default transfer size
        const FREEZE_AMOUNT = 700_000_000n;   // 700 cEUR frozen → 300 available
        const AVAILABLE_AMOUNT = 300_000_000n;   // 1000 - 700
        const OVERDRAW_AMOUNT = 400_000_000n;   // > 300 → silent failure
        const UNWRAP_OVERDRAW = 500_000_000n;   // > 300

        beforeEach(async function () {
            ({ ceur, eurc, agent, user1: alice, user2: bob, outsider } = await deployFixture());

            // KYC both happy-path users.
            await ceur.connect(agent).approveUser(alice.address);
            await ceur.connect(agent).approveUser(bob.address);

            // Pre-fund Alice via wrap so every transfer test starts from a known state.
            await eurc.connect(alice).mint(alice.address, WRAP_AMOUNT);
            await eurc.connect(alice).approve(await ceur.getAddress(), WRAP_AMOUNT);
            await ceur.connect(alice).wrap(alice.address, WRAP_AMOUNT);
        });


        it("pause blocks confidentialTransfer", async function () {
            await ceur.connect(agent).pause();
            
            // Alice encrypts 500 cEUR.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                TRANSFER_AMOUNT,
                await ceur.getAddress(),
                alice.address
            );

            // Alice → Bob, 500 cEUR.
            await expect(
                ceur.connect(alice)["confidentialTransfer(address,bytes32,bytes)"](
                    bob.address,
                    enc.externalEuint,
                    enc.inputProof
                )
            ).to.be.revertedWithCustomError(ceur, "EnforcedPause");
        });

        it("unpause restores transfers", async function () {
            await ceur.connect(agent).pause();
            await ceur.connect(agent).unpause();
            
            // Alice encrypts 500 cEUR.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                TRANSFER_AMOUNT,
                await ceur.getAddress(),
                alice.address
            );

            // Alice → Bob, 500 cEUR.
            await ceur.connect(alice)["confidentialTransfer(address,bytes32,bytes)"](
                bob.address,
                enc.externalEuint,
                enc.inputProof
            );

            // Alice: 1000 - 500 = 500
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const aliceBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, aliceHandle, await ceur.getAddress(), alice
            );
            expect(aliceBalance).to.equal(WRAP_AMOUNT - TRANSFER_AMOUNT);

            // Bob: 0 + 500 = 500
            const bobHandle = await ceur.confidentialBalanceOf(bob.address);
            const bobBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, bobHandle, await ceur.getAddress(), bob
            );
            expect(bobBalance).to.equal(TRANSFER_AMOUNT); 
        });

        it("partial freeze allows transfer within available", async function () {
            // Agent encrypts the freeze amount — proof binds to msg.sender = agent.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                FREEZE_AMOUNT,
                await ceur.getAddress(),
                agent.address
            );
            
            await ceur.connect(agent)["setConfidentialFrozen(address,bytes32,bytes)"](
                alice.address,
                enc.externalEuint,
                enc.inputProof
            );

            // Alice encrypts 300 cEUR.
            const enc2 = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                AVAILABLE_AMOUNT,
                await ceur.getAddress(),
                alice.address
            );

            // Alice → Bob, 300 cEUR.
            await ceur.connect(alice)["confidentialTransfer(address,bytes32,bytes)"](
                bob.address,
                enc2.externalEuint,
                enc2.inputProof
            );

            // Alice: 1000 - 300 = 700
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const aliceBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, aliceHandle, await ceur.getAddress(), alice
            );
            expect(aliceBalance).to.equal(WRAP_AMOUNT - AVAILABLE_AMOUNT);

            // Bob: 0 + 300 = 300
            const bobHandle = await ceur.confidentialBalanceOf(bob.address);
            const bobBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, bobHandle, await ceur.getAddress(), bob
            );
            expect(bobBalance).to.equal(AVAILABLE_AMOUNT); 
        });

        it("partial freeze silently fails above available", async function () {
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                FREEZE_AMOUNT,
                await ceur.getAddress(),
                agent.address
            );
            
            await ceur.connect(agent)["setConfidentialFrozen(address,bytes32,bytes)"](
                alice.address,
                enc.externalEuint,
                enc.inputProof
            );

            // Alice encrypts 400 cEUR.
            const enc2 = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                OVERDRAW_AMOUNT,
                await ceur.getAddress(),
                alice.address
            );

            // Alice → Bob, 400 cEUR.
            await ceur.connect(alice)["confidentialTransfer(address,bytes32,bytes)"](
                bob.address,
                enc2.externalEuint,
                enc2.inputProof
            );

            // Alice: 1000 - 0 = 1000
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const aliceBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, aliceHandle, await ceur.getAddress(), alice
            );
            expect(aliceBalance).to.equal(WRAP_AMOUNT);

            // Bob: 0 + 0 = 0
            const bobHandle = await ceur.confidentialBalanceOf(bob.address);
            const bobBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, bobHandle, await ceur.getAddress(), bob
            );
            expect(bobBalance).to.equal(0n);
        });

        it("freeze blocks unwrap above available", async function () {
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                FREEZE_AMOUNT,
                await ceur.getAddress(),
                agent.address
            );
            
            await ceur.connect(agent)["setConfidentialFrozen(address,bytes32,bytes)"](
                alice.address,
                enc.externalEuint,
                enc.inputProof
            );

            const unwrapEnc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                UNWRAP_OVERDRAW,
                await ceur.getAddress(),
                alice.address
            );

            const tx = await ceur.connect(alice)["unwrap(address,address,bytes32,bytes)"](
                alice.address,
                alice.address,
                unwrapEnc.externalEuint,
                unwrapEnc.inputProof
            );
            const receipt = await tx.wait();

            // extract burntAmount handle from UnwrapRequested event
            const unwrapEvent = receipt.logs.find(
                (log: any) => ceur.interface.parseLog(log)?.name === "UnwrapRequested"
            );
            const parsed = ceur.interface.parseLog(unwrapEvent);
            const burntAmountHandle = parsed.args.amount;

            // get decryption proof from mock
            const decryptionResult = await hre.fhevm.publicDecrypt([burntAmountHandle]);
            const cleartext = decryptionResult.clearValues[burntAmountHandle];
            const proof = decryptionResult.decryptionProof;

            expect(cleartext).to.equal(0n);

            // finalize — verifies proof, releases EURC
            await ceur.finalizeUnwrap(burntAmountHandle, cleartext, proof);

            // Alice gets nothing back.
            expect(await eurc.balanceOf(alice.address)).to.equal(0n);

            // EURC stays locked in the pool.
            expect(await eurc.balanceOf(await ceur.getAddress())).to.equal(WRAP_AMOUNT);

            // Alice's confidential balance unchanged — the actual burn was 0.
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const aliceBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, aliceHandle, await ceur.getAddress(), alice
            );
            expect(aliceBalance).to.equal(WRAP_AMOUNT);

        });

        it("force bypasses pause", async function () {
            // Pause the contract — normal transfers would revert with EnforcedPause.
            await ceur.connect(agent).pause();

            // Agent encrypts the transfer amount — proof binds to msg.sender = agent.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                TRANSFER_AMOUNT,
                await ceur.getAddress(),
                agent.address
            );

            // Force transfer bypasses Wrapper(1) + Rwa(2) → no whenNotPaused check.
            await ceur.connect(agent)["forceConfidentialTransferFrom(address,address,bytes32,bytes)"](
                alice.address,
                bob.address,
                enc.externalEuint,
                enc.inputProof
            );

            // Alice: 1000 - 500 = 500
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const aliceBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, aliceHandle, await ceur.getAddress(), alice
            );
            expect(aliceBalance).to.equal(WRAP_AMOUNT - TRANSFER_AMOUNT);

            // Bob: 0 + 500 = 500
            const bobHandle = await ceur.confidentialBalanceOf(bob.address);
            const bobBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, bobHandle, await ceur.getAddress(), bob
            );
            expect(bobBalance).to.equal(TRANSFER_AMOUNT);
        });

        it("force bypasses sender restriction", async function () {
            // Revoke Alice's KYC — a normal transfer from Alice would now revert with UserRestricted.
            await ceur.connect(agent).revokeUser(alice.address);

            // Agent encrypts the transfer amount.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                TRANSFER_AMOUNT,
                await ceur.getAddress(),
                agent.address
            );

            // Force transfer skips _checkSenderRestriction via the msg.sig override in Rwa.
            await ceur.connect(agent)["forceConfidentialTransferFrom(address,address,bytes32,bytes)"](
                alice.address,
                bob.address,
                enc.externalEuint,
                enc.inputProof
            );

            // Alice: 1000 - 500 = 500
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const aliceBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, aliceHandle, await ceur.getAddress(), alice
            );
            expect(aliceBalance).to.equal(WRAP_AMOUNT - TRANSFER_AMOUNT);

            // Bob: 0 + 500 = 500
            const bobHandle = await ceur.confidentialBalanceOf(bob.address);
            const bobBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, bobHandle, await ceur.getAddress(), bob
            );
            expect(bobBalance).to.equal(TRANSFER_AMOUNT);
        });

        it("force does not bypass receiver restriction", async function () {
            // Outsider has no KYC. Rwa only overrides _checkSenderRestriction —
            // the recipient still goes through Restricted's _checkRecipientRestriction.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                TRANSFER_AMOUNT,
                await ceur.getAddress(),
                agent.address
            );

            await expect(
                ceur.connect(agent)["forceConfidentialTransferFrom(address,address,bytes32,bytes)"](
                    alice.address,
                    outsider.address,
                    enc.externalEuint,
                    enc.inputProof
                )
            ).to.be.revertedWithCustomError(ceur, "UserRestricted")
                .withArgs(outsider.address);
        });

        it("force does not bypass freeze", async function () {
            // Freeze 700 of Alice's 1000 → 300 available.
            const freezeEnc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                FREEZE_AMOUNT,
                await ceur.getAddress(),
                agent.address
            );

            await ceur.connect(agent)["setConfidentialFrozen(address,bytes32,bytes)"](
                alice.address,
                freezeEnc.externalEuint,
                freezeEnc.inputProof
            );

            // Try to force-transfer 400 — exceeds the 300 available.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                OVERDRAW_AMOUNT,
                await ceur.getAddress(),
                agent.address
            );

            // Force bypasses Wrapper(1) + Rwa(2) but still goes through Freezable(5).
            // FHE.select clamps the transfer to 0 → silent failure.
            await ceur.connect(agent)["forceConfidentialTransferFrom(address,address,bytes32,bytes)"](
                alice.address,
                bob.address,
                enc.externalEuint,
                enc.inputProof
            );

            // Alice: unchanged at 1000
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const aliceBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, aliceHandle, await ceur.getAddress(), alice
            );
            expect(aliceBalance).to.equal(WRAP_AMOUNT);

            // Bob: still 0
            const bobHandle = await ceur.confidentialBalanceOf(bob.address);
            const bobBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, bobHandle, await ceur.getAddress(), bob
            );
            expect(bobBalance).to.equal(0n);
        });


    });


    describe("Observer (M7)", function () {
        let ceur: any;
        let eurc: any;
        let agent: any;
        let alice: any;     // = user1, account holder
        let bob: any;       // = user2, user-set observer (no KYC needed)
        let charlie: any;   // = user3, transfer recipient
        let outsider: any;

        const WRAP_AMOUNT = 1000_000_000n;  // 1000 cEUR, Alice's starting balance
        const TRANSFER_AMOUNT = 500_000_000n;   // 500 cEUR

        beforeEach(async function () {
            ({ ceur, eurc, agent, user1: alice, user2: bob, user3: charlie, outsider } = await deployFixture());

            // Alice and Charlie get KYC'd; Bob deliberately does NOT — observers don't transfer.
            await ceur.connect(agent).approveUser(alice.address);
            await ceur.connect(agent).approveUser(charlie.address);

            // Pre-fund Alice via wrap so her balance handle is initialized.
            await eurc.connect(alice).mint(alice.address, WRAP_AMOUNT);
            await eurc.connect(alice).approve(await ceur.getAddress(), WRAP_AMOUNT);
            await ceur.connect(alice).wrap(alice.address, WRAP_AMOUNT);
        });

        it("setObserver grants the observer access to the existing balance", async function () {
            // Alice appoints Bob — setObserver's initial ACL grant covers the existing balance handle.
            await ceur.connect(alice).setObserver(alice.address, bob.address);

            // Bob can decrypt Alice's balance — proof that FHE.allow(balanceHandle, bob) ran inside setObserver.
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const balanceSeenByBob = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, aliceHandle, await ceur.getAddress(), bob
            );
            expect(balanceSeenByBob).to.equal(WRAP_AMOUNT);
        });

        it("observer keeps access after a subsequent transfer", async function () {
            // Alice appoints Bob — initial ACL grant covers the current balance handle.
            await ceur.connect(alice).setObserver(alice.address, bob.address);

            // Alice transfers 500 cEUR to Charlie — _update produces a new balance handle for Alice.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                TRANSFER_AMOUNT,
                await ceur.getAddress(),
                alice.address
            );
            await ceur.connect(alice)["confidentialTransfer(address,bytes32,bytes)"](
                charlie.address,
                enc.externalEuint,
                enc.inputProof
            );

            // Bob can still decrypt Alice's NEW balance — proof that the _update hook re-allowed him.
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const balanceSeenByBob = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, aliceHandle, await ceur.getAddress(), bob
            );
            expect(balanceSeenByBob).to.equal(WRAP_AMOUNT - TRANSFER_AMOUNT);
        });

        it("observer abdication revokes ACL on future balance handles", async function () {
            // Alice appoints Bob, then Bob abdicates — second require-branch in setObserver permits self-removal.
            await ceur.connect(alice).setObserver(alice.address, bob.address);
            await ceur.connect(bob).setObserver(alice.address, ethers.ZeroAddress);

            // Alice transfers — _update produces a new balance handle, but observer(alice) is now address(0).
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                TRANSFER_AMOUNT,
                await ceur.getAddress(),
                alice.address
            );
            await ceur.connect(alice)["confidentialTransfer(address,bytes32,bytes)"](
                charlie.address,
                enc.externalEuint,
                enc.inputProof
            );

            // Bob cannot decrypt the NEW balance handle — no ACL was granted to him post-abdication.
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            await expect(
                hre.fhevm.userDecryptEuint(FhevmType.euint64, aliceHandle, await ceur.getAddress(), bob)
            ).to.be.rejected;
        });

        it("outsiders cannot set someone else's observer", async function () {
            // Outsider is neither the account holder nor the current observer — both require-branches in setObserver fail.
            await expect(
                ceur.connect(outsider).setObserver(alice.address, outsider.address)
            ).to.be.revertedWithCustomError(ceur, "Unauthorized");
        });
    });


    describe("Regulatory observer (M7)", function () {
        let ceur: any;
        let eurc: any;
        let agent: any;
        let alice: any;       // KYC'd account holder
        let bob: any;         // user-set observer (no KYC needed)
        let charlie: any;     // KYC'd transfer recipient
        let regulator: any;   // agent-appointed, no KYC needed
        let regulatorB: any;  // Charlie's regulator, agent-appointed
        let outsider: any;

        const WRAP_AMOUNT = 1000_000_000n;
        const TRANSFER_AMOUNT = 500_000_000n;

        beforeEach(async function () {
            ({ ceur, eurc, agent, user1: alice, user2: bob, user3: charlie, user4: regulator, user5: regulatorB, outsider } = await deployFixture());

            await ceur.connect(agent).approveUser(alice.address);
            await ceur.connect(agent).approveUser(charlie.address);

            await eurc.connect(alice).mint(alice.address, WRAP_AMOUNT);
            await eurc.connect(alice).approve(await ceur.getAddress(), WRAP_AMOUNT);
            await ceur.connect(alice).wrap(alice.address, WRAP_AMOUNT);
        });

        it("setRegulatoryObserver grants the regulator access to the existing balance", async function () {
            // Agent appoints a regulator for Alice — the setter's init-guarded FHE.allow grants the regulator ACL on the current handle.
            await ceur.connect(agent).setRegulatoryObserver(alice.address, regulator.address);

            // Regulator can decrypt Alice's balance — proof that FHE.allow ran inside the setter.
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const balanceSeenByRegulator = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, aliceHandle, await ceur.getAddress(), regulator
            );
            expect(balanceSeenByRegulator).to.equal(WRAP_AMOUNT);
        });

        it("regulator keeps access after a transfer", async function () {
            // Agent appoints the regulator — initial ACL grant covers Alice's current balance handle.
            await ceur.connect(agent).setRegulatoryObserver(alice.address, regulator.address);

            // Alice transfers 500 cEUR to Charlie — _update produces a new balance handle for Alice.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                TRANSFER_AMOUNT,
                await ceur.getAddress(),
                alice.address
            );
            await ceur.connect(alice)["confidentialTransfer(address,bytes32,bytes)"](
                charlie.address,
                enc.externalEuint,
                enc.inputProof
            );

            // Regulator can still decrypt Alice's NEW balance — proof that the _update hook re-allowed the regulator on the new handle.
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const balanceSeenByRegulator = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, aliceHandle, await ceur.getAddress(), regulator
            );
            expect(balanceSeenByRegulator).to.equal(WRAP_AMOUNT - TRANSFER_AMOUNT);
        });

        it("user-observer and regulator coexist on the same handle after a transfer", async function () {
            // Alice appoints Bob as her user-observer; agent appoints the regulator. Two parallel ACL paths on the same balance.
            await ceur.connect(alice).setObserver(alice.address, bob.address);
            await ceur.connect(agent).setRegulatoryObserver(alice.address, regulator.address);

            // Alice transfers 500 cEUR to Charlie — _update walks OZ's user-observer refresh AND our regulator refresh on the new handle.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                TRANSFER_AMOUNT,
                await ceur.getAddress(),
                alice.address
            );
            await ceur.connect(alice)["confidentialTransfer(address,bytes32,bytes)"](
                charlie.address,
                enc.externalEuint,
                enc.inputProof
            );

            // Both can decrypt the NEW balance handle — orthogonal composition: neither mechanism shadows the other.
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const balanceSeenByBob = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, aliceHandle, await ceur.getAddress(), bob
            );
            const balanceSeenByRegulator = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, aliceHandle, await ceur.getAddress(), regulator
            );
            expect(balanceSeenByBob).to.equal(WRAP_AMOUNT - TRANSFER_AMOUNT);
            expect(balanceSeenByRegulator).to.equal(WRAP_AMOUNT - TRANSFER_AMOUNT);
        });

        it("force transfer grants ACL to regulators on both sides", async function () {
            // Two regulators, one per account — the _update hook must refresh both ACLs on a single transfer.
            await ceur.connect(agent).setRegulatoryObserver(alice.address, regulator.address);
            await ceur.connect(agent).setRegulatoryObserver(charlie.address, regulatorB.address);

            // Agent-encrypted transfer — proof binds to msg.sender = agent for the force path.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                TRANSFER_AMOUNT,
                await ceur.getAddress(),
                agent.address
            );
            await ceur.connect(agent)["forceConfidentialTransferFrom(address,address,bytes32,bytes)"](
                alice.address,
                charlie.address,
                enc.externalEuint,
                enc.inputProof
            );

            // Alice's regulator decrypts Alice's new balance — from-side branch fired.
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const aliceSeenByRegulator = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, aliceHandle, await ceur.getAddress(), regulator
            );
            expect(aliceSeenByRegulator).to.equal(WRAP_AMOUNT - TRANSFER_AMOUNT);

            // Charlie's regulator decrypts Charlie's new balance — to-side branch fired (handle freshly initialised by _update).
            const charlieHandle = await ceur.confidentialBalanceOf(charlie.address);
            const charlieSeenByRegulatorB = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, charlieHandle, await ceur.getAddress(), regulatorB
            );
            expect(charlieSeenByRegulatorB).to.equal(TRANSFER_AMOUNT);
        });

        it("outsiders cannot setRegulatoryObserver", async function () {
            // Setter is agent-gated — neither the account holder nor a random caller has AGENT_ROLE.
            await expect(
                ceur.connect(outsider).setRegulatoryObserver(alice.address, regulator.address)
            ).to.be.revertedWithCustomError(ceur, "AccessControlUnauthorizedAccount");
        });

        it("setting a regulator for an unfunded account succeeds and grants ACL on the first inflow", async function () {
            // Charlie is KYC'd but has no balance — confidentialBalanceOf returns an uninitialised handle.
            // The setter's init-guard skips FHE.allow without reverting.
            await expect(
                ceur.connect(agent).setRegulatoryObserver(charlie.address, regulator.address)
            ).to.not.be.reverted;

            // Mapping is persisted regardless — the skipped FHE.allow is independent of the slot update.
            expect(await ceur.regulatoryObserver(charlie.address)).to.equal(regulator.address);

            // Alice transfers 500 cEUR to Charlie — _update initialises Charlie's handle AND the to-side branch in
            // _grantRegulatoryAccess grants the catch-up ACL.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                TRANSFER_AMOUNT,
                await ceur.getAddress(),
                alice.address
            );
            await ceur.connect(alice)["confidentialTransfer(address,bytes32,bytes)"](
                charlie.address,
                enc.externalEuint,
                enc.inputProof
            );

            // Regulator decrypts Charlie's freshly initialised balance — proof that the catch-up grant fired.
            const charlieHandle = await ceur.confidentialBalanceOf(charlie.address);
            const charlieSeenByRegulator = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, charlieHandle, await ceur.getAddress(), regulator
            );
            expect(charlieSeenByRegulator).to.equal(TRANSFER_AMOUNT);
        });

        it("clearing the regulator stops future grants but preserves past ACL", async function () {
            // Set the regulator and capture Alice's current handle — the setter grants ACL on this exact ciphertext.
            await ceur.connect(agent).setRegulatoryObserver(alice.address, regulator.address);
            const oldHandle = await ceur.confidentialBalanceOf(alice.address);

            // Sanity: regulator can decrypt the current handle while still in office.
            const balanceBefore = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, oldHandle, await ceur.getAddress(), regulator
            );
            expect(balanceBefore).to.equal(WRAP_AMOUNT);

            // Soft-revoke — mapping cleared, getter confirms, _grantRegulatoryAccess will now skip both branches.
            await ceur.connect(agent).setRegulatoryObserver(alice.address, ethers.ZeroAddress);
            expect(await ceur.regulatoryObserver(alice.address)).to.equal(ethers.ZeroAddress);

            // Alice transfers — _update produces a new balance handle, but _grantRegulatoryAccess sees mapping==0 and skips.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                TRANSFER_AMOUNT,
                await ceur.getAddress(),
                alice.address
            );
            await ceur.connect(alice)["confidentialTransfer(address,bytes32,bytes)"](
                charlie.address,
                enc.externalEuint,
                enc.inputProof
            );

            // Past ACL preserved: regulator can still decrypt the OLD handle — FHE-ACL is per-handle persistent.
            const balanceFromOldHandle = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, oldHandle, await ceur.getAddress(), regulator
            );
            expect(balanceFromOldHandle).to.equal(WRAP_AMOUNT);

            // Future grants stopped: regulator cannot decrypt the NEW handle.
            const newHandle = await ceur.confidentialBalanceOf(alice.address);
            await expect(
                hre.fhevm.userDecryptEuint(FhevmType.euint64, newHandle, await ceur.getAddress(), regulator)
            ).to.be.rejected;
        });

    });

});
