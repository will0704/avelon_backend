/**
 * Drive one borrower's newest loan from wherever it is to ACTIVE, for a demo
 * recording, using real transactions on the local Hardhat chain.
 *
 * Nothing here is faked. recordCollateralDeposit checks the tx on chain — sender,
 * recipient, decoded loan id, amount, confirmations — so a made-up hash is refused
 * by the same code path the app uses. The only difference from a phone-driven run
 * is which key signs: a published Hardhat test key instead of the borrower's
 * MetaMask, because the local node is not reachable from a handset.
 *
 * Idempotent — run it again after each app step and it picks up where it left off.
 *
 *   npx tsx scripts/demo-drive-loan.ts <email> [accountIndex]
 *   npx tsx scripts/demo-drive-loan.ts <email> --clear    # scrap the current loan
 *
 * --clear deletes the borrower's unfinished loan so they can apply again for
 * another take. createLoan refuses a second application while one is open, so
 * without it the second recording cannot start. The on-chain loan it leaves
 * behind is inert on a throwaway local chain.
 */
import { ethers } from 'ethers';
import { prisma } from '../src/lib/prisma';
import { loanService } from '../src/services/loan.service';
import { walletService } from '../src/services/wallet.service';
import { investorService } from '../src/services/investor.service';

const LOCAL_CHAIN_ID = 31337;
const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';
const DEFAULT_ACCOUNT_INDEX = 5;
const CM_ABI = ['function depositCollateral(uint32 loanId) payable'];
const POOL_ABI = [
    'function deposit() payable',
    'function availableLiquidity() view returns (uint256)',
];

// Hardhat accounts 0-9, so a seeded wallet can be matched back to a key.
const HARDHAT_INDEX = new Map<string, number>(
    Array.from({ length: 10 }, (_, i) => [signerFor(i).address.toLowerCase(), i]),
);

/**
 * Loans disburse from the investor pool, so an empty pool means approval succeeds
 * and activation then fails with nothing to lend. Top it up with a real deposit
 * from a seeded investor rather than letting the demo die halfway through.
 */
async function ensurePoolLiquidity(needed: bigint, provider: ethers.JsonRpcProvider) {
    const poolAddress = process.env.LIQUIDITY_POOL_ADDRESS;
    if (!poolAddress) {
        console.error('LIQUIDITY_POOL_ADDRESS is unset. Run npm run demo:reset first.');
        process.exit(1);
    }

    const read = new ethers.Contract(poolAddress, POOL_ABI, provider);
    const available: bigint = await read.availableLiquidity();
    if (available >= needed) {
        console.log(`pool      ${ethers.formatEther(available)} ETH available, enough`);
        return;
    }

    const investors = await prisma.user.findMany({
        where: { role: 'INVESTOR' },
        select: { id: true, email: true, wallets: { where: { isVerified: true }, select: { address: true } } },
    });
    const found = investors.flatMap((u) =>
        u.wallets
            .map((w) => ({ user: u, index: HARDHAT_INDEX.get(w.address.toLowerCase()) }))
            .filter((c): c is { user: typeof u; index: number } => c.index !== undefined),
    )[0];

    if (!found) {
        console.error('Pool is short and no seeded investor holds a Hardhat wallet to top it up with.');
        process.exit(1);
    }

    // A little over the requirement so gas and rounding cannot leave it just short.
    const topUp = ((needed - available) * 12n) / 10n + ethers.parseEther('0.01');
    const pool = new ethers.Contract(poolAddress, POOL_ABI, signerFor(found.index).connect(provider));
    console.log(`pool      ${ethers.formatEther(available)} ETH available, depositing ${ethers.formatEther(topUp)} ETH as ${found.user.email}…`);

    const tx = await pool.deposit({ value: topUp });
    await tx.wait();
    await investorService.recordDeposit(found.user.id, tx.hash);
    console.log(`pool      now ${ethers.formatEther(await read.availableLiquidity())} ETH available`);
}

function signerFor(index: number) {
    return ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);
}

async function main() {
    const email = process.argv[2];
    const clear = process.argv.includes('--clear');
    const index = Number(
        process.argv.slice(3).find((a) => !a.startsWith('--')) ?? DEFAULT_ACCOUNT_INDEX,
    );

    if (process.env.NODE_ENV === 'production') {
        console.error('Refusing to run with NODE_ENV=production.');
        process.exit(1);
    }
    if (!email) {
        console.error('Usage: npx tsx scripts/demo-drive-loan.ts <email> [accountIndex]');
        process.exit(1);
    }

    const chainId = Number(process.env.CHAIN_ID ?? 0);
    if (chainId !== LOCAL_CHAIN_ID) {
        console.error(`Refusing to run: CHAIN_ID is ${chainId || 'unset'}, not ${LOCAL_CHAIN_ID}.`);
        console.error('These are published test keys — using them off the local chain would be unsafe.');
        process.exit(1);
    }

    const cmAddress = process.env.COLLATERAL_MANAGER_ADDRESS;
    if (!cmAddress) {
        console.error('COLLATERAL_MANAGER_ADDRESS is unset. Run npm run demo:reset first.');
        process.exit(1);
    }

    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, creditScore: true } });
    if (!user) {
        console.error(`No user with email ${email}`);
        process.exit(1);
    }

    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true } });
    if (!admin) {
        console.error('No ADMIN user exists. Run the seed first.');
        process.exit(1);
    }

    if (clear) {
        const open = await prisma.loan.findMany({
            where: {
                userId: user.id,
                status: { in: ['PENDING_APPROVAL', 'PENDING_COLLATERAL', 'COLLATERAL_DEPOSITED', 'ACTIVE'] },
            },
            select: { id: true, status: true },
        });
        for (const l of open) {
            await prisma.loanTransaction.deleteMany({ where: { loanId: l.id } });
            await prisma.loan.delete({ where: { id: l.id } });
            console.log(`cleared   ${l.id}  ${l.status}`);
        }
        console.log(open.length ? `\n${open.length} loan(s) removed — the borrower can apply again.` : 'Nothing open to clear.');
        await prisma.$disconnect();
        return;
    }

    const signer = signerFor(index);
    const address = signer.address.toLowerCase();

    // ── wallet ───────────────────────────────────────────────────────────
    // The loan records whichever wallet was primary when it was created, and the
    // collateral check demands the deposit come from that exact address. So this
    // has to be in place before the borrower applies, not after.
    const existing = await prisma.wallet.findFirst({
        where: { userId: user.id, address, isVerified: true },
        select: { id: true },
    });
    if (existing) {
        console.log(`wallet    already linked  ${signer.address} (Hardhat #${index})`);
    } else {
        const message = await walletService.generateAndStoreNonce(user.id, address, chainId);
        const signature = await signer.signMessage(message);
        await walletService.verifySignature(user.id, address, chainId, signature, message);
        console.log(`wallet    linked          ${signer.address} (Hardhat #${index})`);
    }

    // ── loan ─────────────────────────────────────────────────────────────
    let loan = await prisma.loan.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        include: { wallet: { select: { address: true } } },
    });

    if (!loan) {
        console.log('\nNo loan yet. Have the borrower apply in the app, then run this again.');
        await prisma.$disconnect();
        return;
    }
    console.log(`loan      ${loan.id}  ${loan.status}`);

    if (loan.wallet.address.toLowerCase() !== address) {
        console.error(`\nThis loan is bound to ${loan.wallet.address}, which this script cannot sign for.`);
        console.error('Link the Hardhat wallet first, then have the borrower apply for a NEW loan.');
        process.exit(1);
    }

    if (loan.status === 'PENDING_APPROVAL') {
        const rpc = new ethers.JsonRpcProvider(process.env.RPC_URL ?? 'http://127.0.0.1:8545');
        await ensurePoolLiquidity(ethers.parseEther(loan.principal.toString()), rpc);

        const approved = await loanService.approveLoan(loan.id, admin.id);
        console.log(`approve   -> ${approved.status}  contractLoanId ${approved.contractLoanId}`);
        loan = await prisma.loan.findUniqueOrThrow({
            where: { id: loan.id },
            include: { wallet: { select: { address: true } } },
        });
    }

    if (loan.status === 'PENDING_COLLATERAL') {
        if (loan.contractLoanId === null) {
            console.error('Loan has no on-chain id — approval did not reach the chain.');
            process.exit(1);
        }
        const provider = new ethers.JsonRpcProvider(process.env.RPC_URL ?? 'http://127.0.0.1:8545');
        const cm = new ethers.Contract(cmAddress, CM_ABI, signer.connect(provider));

        const required = loan.collateralRequired.toString();
        console.log(`deposit   sending ${required} ETH to CollateralManager…`);
        const tx = await cm.depositCollateral(loan.contractLoanId, { value: ethers.parseEther(required) });
        await tx.wait();
        console.log(`deposit   mined ${tx.hash}`);

        const result = await loanService.recordCollateralDeposit(loan.id, user.id, tx.hash);
        console.log(`record    -> ${result.loan.status}`);
        loan = await prisma.loan.findUniqueOrThrow({
            where: { id: loan.id },
            include: { wallet: { select: { address: true } } },
        });
    }

    console.log(`\nfinal     ${loan.status}`);
    console.log(`  principal   ${loan.principal}`);
    console.log(`  collateral  ${loan.collateralDeposited} / ${loan.collateralRequired}`);
    if (loan.status !== 'ACTIVE') {
        console.log('\nNot ACTIVE yet — see the status above for what stage it is at.');
    }

    await prisma.$disconnect();
}

main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
});
