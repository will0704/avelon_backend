import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Avelon Lending Platform Deployment Module
 * 
 * Deploys the three core contracts:
 * 1. AvelonLending - Core lending logic
 * 2. CollateralManager - Collateral escrow
 * 3. RepaymentSchedule - Payment tracking
 * 
 * And links them together.
 */
const AvelonDeployModule = buildModule("AvelonDeployModule", (m) => {
    // Get the treasury address from parameters or use deployer as default
    const treasury = m.getParameter("treasury", m.getAccount(0));

    // Deploy AvelonLending with treasury address
    const avelonLending = m.contract("AvelonLending", [treasury]);

    // Deploy CollateralManager
    const collateralManager = m.contract("CollateralManager", []);

    // Deploy RepaymentSchedule
    const repaymentSchedule = m.contract("RepaymentSchedule", []);

    // Link CollateralManager to AvelonLending
    m.call(collateralManager, "setLendingContract", [avelonLending], {
        id: "CollateralManager_setLendingContract",
    });

    // Link AvelonLending to CollateralManager
    m.call(avelonLending, "setCollateralManager", [collateralManager], {
        id: "AvelonLending_setCollateralManager",
    });

    return {
        avelonLending,
        collateralManager,
        repaymentSchedule,
    };
});

export default AvelonDeployModule;
