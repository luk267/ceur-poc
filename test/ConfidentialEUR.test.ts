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
    const [admin, agent, user1, user2, user3, outsider] = await ethers.getSigners();

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

    return { ceur, eurc, admin, agent, user1, user2, user3, outsider };
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

    describe("Coverage invariant", function () {
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

    describe("Confidential Transfer (M5)", function () {
        let ceur: any;
        let eurc: any;
        let agent: any;
        let alice: any;      // = user1  (sender, will be pre-funded)
        let bob: any;        // = user2  (receiver, starts at 0)
        let charlie: any;    // = user3  (operator-transfer recipient, KYC'd)
        let outsider: any;   // no KYC  (used in KYC-revert tests)

        const WRAP_AMOUNT = 1000_000_000n;      // 1000 cEUR, Alice's starting balance
        const TRANSFER_AMOUNT = 500_000_000n;   // 500 cEUR, default transfer size
        const OVERDRAFT_AMOUNT = 2000_000_000n; // 2000 cEUR, silent failure transfer size
        const FORWARD_AMOUNT = 600_000_000n;    // Alice → Bob
        const BACKWARD_AMOUNT = 200_000_000n;   // Bob → Alice

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

        it("silent failure: transfer exceeds balance", async function () {
            // Alice encrypts 2000 cEUR — more than her balance, will trigger silent failure.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                OVERDRAFT_AMOUNT,
                await ceur.getAddress(),
                alice.address
            );

            // Alice → Bob, 2000 cEUR — pipeline runs but transferred = enc(0).
            await ceur.connect(alice)["confidentialTransfer(address,bytes32,bytes)"](
                bob.address,
                enc.externalEuint,
                enc.inputProof
            );

            // Alice: 1000 (unchanged, FHE.select picked the no-op branch)
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const aliceBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, aliceHandle, await ceur.getAddress(), alice
            );
            expect(aliceBalance).to.equal(WRAP_AMOUNT);

            // Bob: 0 (silent failure → received nothing)
            const bobHandle = await ceur.confidentialBalanceOf(bob.address);
            const bobBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, bobHandle, await ceur.getAddress(), bob
            );
            expect(bobBalance).to.equal(0n);
        });

        it("transfer to self leaves balance unchanged", async function () {
            // Alice encrypts 500 cEUR.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                TRANSFER_AMOUNT,
                await ceur.getAddress(),
                alice.address
            );

            // Alice → Alice, 500 cEUR — pipeline subtracts then re-adds, net zero.
            await ceur.connect(alice)["confidentialTransfer(address,bytes32,bytes)"](
                alice.address,
                enc.externalEuint,
                enc.inputProof
            );

            // Alice: 1000 - 500 + 500 = 1000
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const aliceBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, aliceHandle, await ceur.getAddress(), alice
            );
            expect(aliceBalance).to.equal(WRAP_AMOUNT);
        });

        it("bidirectional transfers preserve total balance", async function () {
            // Alice encrypts 600 cEUR.
            const enc1 = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                FORWARD_AMOUNT,
                await ceur.getAddress(),
                alice.address
            );

            // Alice → Bob, 600 cEUR.
            await ceur.connect(alice)["confidentialTransfer(address,bytes32,bytes)"](
                bob.address,
                enc1.externalEuint,
                enc1.inputProof
            );

            // Bob encrypts 200 cEUR.
            const enc2 = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                BACKWARD_AMOUNT,
                await ceur.getAddress(),
                bob.address
            );

            // Bob → Alice, 200 cEUR.
            await ceur.connect(bob)["confidentialTransfer(address,bytes32,bytes)"](
                alice.address,
                enc2.externalEuint,
                enc2.inputProof
            );

            // Alice: 1000 - 600 + 200 = 600
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const aliceBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, aliceHandle, await ceur.getAddress(), alice
            );
            expect(aliceBalance).to.equal(WRAP_AMOUNT - FORWARD_AMOUNT + BACKWARD_AMOUNT);

            // Bob: 0 + 600 - 200 = 400
            const bobHandle = await ceur.confidentialBalanceOf(bob.address);
            const bobBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, bobHandle, await ceur.getAddress(), bob
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
                alice.address
            );

            // Pipeline reverts at the Restricted layer (stage 4) — Alice is no longer ALLOWED.
            await expect(
                ceur.connect(alice)["confidentialTransfer(address,bytes32,bytes)"](
                    bob.address,
                    enc.externalEuint,
                    enc.inputProof
                )
            ).to.be.revertedWithCustomError(ceur, "UserRestricted");
        });

        it("reverts when receiver is not KYC'd", async function () {
            // Alice encrypts 500 cEUR.
            const enc = await hre.fhevm.encryptUint(
                FhevmType.euint64,
                TRANSFER_AMOUNT,
                await ceur.getAddress(),
                alice.address
            );

            // Outsider was never approved — recipient-side KYC blocks the transfer.
            await expect(
                ceur.connect(alice)["confidentialTransfer(address,bytes32,bytes)"](
                    outsider.address,
                    enc.externalEuint,
                    enc.inputProof
                )
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
                bob.address
            );

            // Bob (operator) moves Alice's funds to Charlie.
            await ceur.connect(bob)["confidentialTransferFrom(address,address,bytes32,bytes)"](
                alice.address,
                charlie.address,
                enc.externalEuint,
                enc.inputProof
            );

            // Alice: 1000 - 500 = 500
            const aliceHandle = await ceur.confidentialBalanceOf(alice.address);
            const aliceBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, aliceHandle, await ceur.getAddress(), alice
            );
            expect(aliceBalance).to.equal(WRAP_AMOUNT - TRANSFER_AMOUNT);

            // Charlie: 0 + 500 = 500
            const charlieHandle = await ceur.confidentialBalanceOf(charlie.address);
            const charlieBalance = await hre.fhevm.userDecryptEuint(
                FhevmType.euint64, charlieHandle, await ceur.getAddress(), charlie
            );
            expect(charlieBalance).to.equal(TRANSFER_AMOUNT);
        });


    });


});
