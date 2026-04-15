import hre from "hardhat";
import { expect } from "chai";
import { ethers } from "hardhat";

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
            expect(await ceur.decimals()).to.equal(6);
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
            ).to.be.reverted;
        });
    });
});
