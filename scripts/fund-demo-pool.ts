/**
 * Fund the local investor pool so approved loans can pay out. demo:reset leaves it
 * empty, and an empty pool means a borrower's stake goes in and nothing comes back.
 *
 * A demo investor deposits from Hardhat #19 through the same contract call and
 * filing path the web portal uses, so the pool, the investor's position and the
 * admin pages all agree.
 *
 *   npm run demo:fund        # tops the pool up to 10 ETH available
 *
 * Local chain only. The investor's email preferences are off, so it never gets mail.
 */
import { ethers } from 'ethers';
import bcrypt from 'bcrypt';
import { prisma } from '../src/lib/prisma';
import { walletService } from '../src/services/wallet.service';
import { investorService } from '../src/services/investor.service';

const LOCAL_CHAIN_ID = 31337;
// Hardhat's published default mnemonic. Test keys only — never funds a real chain.
const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';
// The last default account, well clear of the ones handed out for MetaMask
const ACCOUNT_INDEX = 19;
const INVESTOR = { email: 'investor@avelon.finance', name: 'Avelon Investor', password: 'Investor!Local2026' };
// The contract takes 0.01 to 10 ETH per deposit
const TARGET = ethers.parseEther('10');
const MIN_DEPOSIT = ethers.parseEther('0.01');
const POOL_ABI = [
    'function deposit() payable',
    'function availableLiquidity() view returns (uint256)',
];

async function main() {
    const chainId = Number(process.env.CHAIN_ID ?? 0);
    if (chainId !== LOCAL_CHAIN_ID || process.env.NODE_ENV === 'production') {
        throw new Error(`Refusing to run: CHAIN_ID is ${chainId || 'unset'}, and this only funds the local chain.`);
    }
    const poolAddress = process.env.LIQUIDITY_POOL_ADDRESS;
    if (!poolAddress) throw new Error('LIQUIDITY_POOL_ADDRESS is unset. Run npm run demo:reset first.');

    const provider = new ethers.JsonRpcProvider(process.env.CHAIN_RPC_URL ?? 'http://127.0.0.1:8545', LOCAL_CHAIN_ID);
    const signer = ethers.HDNodeWallet
        .fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${ACCOUNT_INDEX}`)
        .connect(provider);
    const pool = new ethers.Contract(poolAddress, POOL_ABI, signer);

    const available: bigint = await pool.availableLiquidity();
    if (available >= TARGET) {
        console.log(`pool      ${ethers.formatEther(available)} ETH available, nothing to do`);
        return;
    }

    const user = await prisma.user.upsert({
        where: { email: INVESTOR.email },
        update: {},
        create: {
            email: INVESTOR.email,
            passwordHash: await bcrypt.hash(INVESTOR.password, 12),
            name: INVESTOR.name,
            role: 'INVESTOR',
            status: 'APPROVED',
            emailVerified: new Date(),
            kycLevel: 'ENHANCED',
        },
        select: { id: true },
    });

    // Nobody reads this inbox, so nothing may be sent to it
    const noEmail = {
        emailLoanUpdates: false,
        emailRepaymentReminders: false,
        emailLiquidationAlerts: false,
        emailMarketingNews: false,
    };
    await prisma.notificationPreference.upsert({
        where: { userId: user.id },
        update: noEmail,
        create: { userId: user.id, ...noEmail },
    });

    const address = signer.address.toLowerCase();
    const linked = await prisma.wallet.findUnique({ where: { address }, select: { userId: true, isVerified: true } });
    if (linked && linked.userId !== user.id) {
        throw new Error(`Hardhat #${ACCOUNT_INDEX} (${signer.address}) is linked to another account.`);
    }
    if (!linked?.isVerified) {
        // The same challenge the app signs, so the wallet is proven rather than inserted
        const message = await walletService.generateAndStoreNonce(user.id, address, LOCAL_CHAIN_ID);
        const signature = await signer.signMessage(message);
        await walletService.verifySignature(user.id, address, LOCAL_CHAIN_ID, signature, message);
    }

    const shortfall = TARGET - available;
    const amount = shortfall < MIN_DEPOSIT ? MIN_DEPOSIT : shortfall;
    console.log(`pool      ${ethers.formatEther(available)} ETH available, depositing ${ethers.formatEther(amount)} ETH as ${INVESTOR.email}…`);

    const tx = await pool.deposit({ value: amount });
    await tx.wait();
    await investorService.recordDeposit(user.id, tx.hash);

    console.log(`pool      now ${ethers.formatEther(await pool.availableLiquidity())} ETH available`);
    console.log(`investor  ${INVESTOR.email} / ${INVESTOR.password}, wallet Hardhat #${ACCOUNT_INDEX} ${signer.address}`);
}

main()
    .then(() => prisma.$disconnect())
    .catch(async (err) => {
        console.error('\nFunding failed:', err instanceof Error ? err.message : err);
        await prisma.$disconnect();
        process.exit(1);
    });
