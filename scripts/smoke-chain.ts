/**
 * End-to-end chain smoke test against whatever chain CHAIN_ID points at.
 *
 * Runs two loans: one repaid in full, one defaulted and liquidated. Signs with
 * the backend's own wallet, which stands in for borrower, treasury and operator
 * at once — enough to prove the contracts are deployed, linked and behaving.
 *
 *   npx tsx scripts/smoke-chain.ts
 *
 * Costs a few thousand gas-worth of testnet ETH. Do not point it at mainnet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { blockchainService } from '../src/services/blockchain.service.js';
import { chain } from '../src/config/env.js';

// The ABIs inlined in blockchain.service.ts are a curated subset for the app's
// own calls. A smoke test wants the whole surface, so read the compiled artifact.
function abiOf(name: string) {
    const p = path.join(process.cwd(), 'contracts', 'artifacts', 'contracts', `${name}.sol`, `${name}.json`);
    return JSON.parse(fs.readFileSync(p, 'utf-8')).abi;
}

const PRINCIPAL = ethers.parseEther('0.001');
const STAKE = ethers.parseEther('0.00035'); // 35%
const RATE_BPS = 1000;

let failures = 0;

/**
 * Assert, retrying through RPC lag.
 *
 * Providers load-balance across nodes, so a read issued right after a write can
 * land on one that has not caught up and report pre-write state. Bounded polling,
 * so a genuine failure still fails — it just takes the timeout to say so.
 */
async function check(
    label: string,
    probe: () => Promise<[boolean, string]>,
    attempts = 15
): Promise<void> {
    let detail = '';
    for (let i = 0; i < attempts; i++) {
        try {
            const [ok, d] = await probe();
            detail = d;
            if (ok) {
                console.log(`  [OK] ${label}${d ? ' — ' + d : ''}`);
                return;
            }
        } catch (e: any) {
            detail = e?.shortMessage || e?.message || String(e);
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
    console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`);
    failures++;
}

async function loanIdFromCreate(
    tx: ethers.ContractTransactionResponse,
    lending: ethers.Contract
): Promise<number> {
    const receipt = await tx.wait();
    let id: number | null = null;
    for (const log of receipt!.logs) {
        try {
            const parsed = lending.interface.parseLog(log);
            if (parsed?.name === 'LoanCreated') { id = Number(parsed.args[0]); break; }
        } catch { /* not our event */ }
    }
    if (id === null) throw new Error('LoanCreated event not found');

    // The next call estimates gas against the RPC. If the node serving that
    // estimate has not seen this loan yet it prices the LoanNotFound path, and
    // the real tx then runs out of gas. Wait until the loan is readable.
    for (let i = 0; i < 20; i++) {
        const loan = await lending.getLoan(id);
        if (loan.borrower !== ethers.ZeroAddress) return id;
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`loan ${id} never became visible to the RPC`);
}

async function main() {
    const signer = blockchainService.getSigner();
    const me = await signer.getAddress();
    const lending = new ethers.Contract(process.env.AVELON_LENDING_ADDRESS!, abiOf('AvelonLending'), signer);
    const manager = new ethers.Contract(process.env.COLLATERAL_MANAGER_ADDRESS!, abiOf('CollateralManager'), signer);

    console.log(`\nChain ${chain.id} — signer ${me}`);
    console.log(`Balance ${await blockchainService.getBalance(me)} ETH\n`);

    console.log('Wiring');
    await check('CollateralManager -> AvelonLending', async () => {
        const v = await manager.lendingContract();
        return [v.toLowerCase() === (await lending.getAddress()).toLowerCase(), v];
    });
    await check('AvelonLending -> CollateralManager', async () => {
        const v = await lending.collateralManager();
        return [v.toLowerCase() === (await manager.getAddress()).toLowerCase(), v];
    });
    await check('min stake is 3500 bps', async () => {
        const v = Number(await manager.minCollateralRatio());
        return [v === 3500, `${v} bps`];
    });

    // ── happy path ───────────────────────────────────────────────────
    console.log('\nLoan A — repaid in full');
    const idA = await loanIdFromCreate(
        await lending.createLoan(me, PRINCIPAL, STAKE, RATE_BPS, 30 * 24 * 60 * 60), lending
    );
    console.log(`  loan id ${idA}`);

    await (await manager.depositCollateral(idA, { value: STAKE })).wait();
    await check('activates on stake deposit', async () => {
        const [, st] = await lending.getLoanBorrowerAndStatus(idA);
        return [Number(st) === 1, `status ${st}`];
    });
    await check('stake locked', async () => [await manager.isCollateralLocked(idA), '']);

    const [pOwed, iOwed] = await lending.getLoanOwed(idA);
    await (await lending.recordRepayment(idA, pOwed + iOwed)).wait();
    await check('marks repaid', async () => {
        const [, st] = await lending.getLoanBorrowerAndStatus(idA);
        return [Number(st) === 2, `status ${st}`];
    });

    const provider = blockchainService.getProvider();
    const cmAddr = await manager.getAddress();
    const relRcpt = await (await manager.releaseCollateral(idA)).wait();
    await check('stake left the manager', async () => {
        const before = await provider.getBalance(cmAddr, relRcpt!.blockNumber - 1);
        const after = await provider.getBalance(cmAddr, relRcpt!.blockNumber);
        return [before - after === STAKE, ethers.formatEther(before - after) + ' ETH'];
    });
    await check('borrower received it', async () => {
        const before = await provider.getBalance(me, relRcpt!.blockNumber - 1);
        const after = await provider.getBalance(me, relRcpt!.blockNumber);
        // net of gas and the L1 data fee, so assert direction and rough size
        return [after > before, ethers.formatEther(after - before) + ' ETH net of fees'];
    });

    // ── default path ─────────────────────────────────────────────────
    console.log('\nLoan B — defaulted and liquidated');
    const idB = await loanIdFromCreate(
        await lending.createLoan(me, PRINCIPAL, STAKE, RATE_BPS, 1), lending // 1s term, overdue immediately
    );
    console.log(`  loan id ${idB}`);

    await (await manager.depositCollateral(idB, { value: STAKE })).wait();

    // wait out the 1s term plus a block
    await new Promise((r) => setTimeout(r, 4000));
    await check('reports overdue', async () => [await lending.isOverdue(idB), '']);

    const treasury: string = await lending.treasury();
    const liqRcpt = await (await manager.liquidate(idB, 0, 0)).wait(); // 0 = Default

    await check('marks liquidated', async () => {
        const [, st] = await lending.getLoanBorrowerAndStatus(idB);
        return [Number(st) === 3, `status ${st}`];
    });
    // Absolute zero would be wrong — other loans may still hold stake here
    await check('stake left the manager', async () => {
        const before = await provider.getBalance(cmAddr, liqRcpt!.blockNumber - 1);
        const after = await provider.getBalance(cmAddr, liqRcpt!.blockNumber);
        return [before - after === STAKE, ethers.formatEther(before - after) + ' ETH'];
    });
    await check('treasury received it', async () => {
        const before = await provider.getBalance(treasury, liqRcpt!.blockNumber - 1);
        const after = await provider.getBalance(treasury, liqRcpt!.blockNumber);
        return [after > before, ethers.formatEther(after - before) + ' ETH net of fees'];
    });

    console.log(`\n${failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED'}\n`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('\nSmoke test error:', e?.shortMessage || e?.message || e);
    process.exit(1);
});
