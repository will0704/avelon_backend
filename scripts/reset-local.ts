/**
 * Reset the local demo to a clean, repeatable starting point.
 *
 * Redeploys the four contracts to the running Hardhat node, rewrites the addresses
 * in .env, and clears every transactional row so the next run starts from zero.
 * Accounts, loan plans and system config survive — re-seed only if you want those
 * rebuilt too.
 *
 * --accounts also deletes every account except KEEP_ACCOUNTS, with their KYC uploads
 * and the email outbox, so the same people and wallets can sign up again.
 *
 *     cd contracts && npx hardhat node      # in its own terminal
 *     npx tsx scripts/reset-local.ts
 *     npx tsx scripts/reset-local.ts --accounts
 *
 * Refuses to touch anything unless the chain is 31337 and the database is on
 * localhost. This script deletes data; the guards are the point.
 */
import { ethers } from 'ethers';
import { config } from 'dotenv';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
config({ path: path.join(root, '.env') });

const LOCAL_CHAIN_ID = 31337;
const RPC = process.env.CHAIN_RPC_URL ?? 'http://127.0.0.1:8545';

// --accounts keeps these and deletes every other account
const KEEP_ACCOUNTS = ['admin@avelon.finance', 'qa.admin@example.com'];
const wipeAccounts = process.argv.includes('--accounts');

async function guard() {
    const url = new URL(process.env.DATABASE_URL!);
    if (!/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) {
        throw new Error(`Refusing to run: DATABASE_URL points at "${url.hostname}", not localhost.`);
    }

    const provider = new ethers.JsonRpcProvider(RPC, LOCAL_CHAIN_ID);
    const net = await provider.getNetwork().catch(() => {
        throw new Error(`No chain at ${RPC}. Start it with: cd contracts && npx hardhat node`);
    });
    if (Number(net.chainId) !== LOCAL_CHAIN_ID) {
        throw new Error(`Refusing to run: chain is ${net.chainId}, expected ${LOCAL_CHAIN_ID}.`);
    }

    console.log(`Target: chain ${LOCAL_CHAIN_ID} at ${RPC}, database ${url.hostname}${url.pathname}`);
}

function redeploy() {
    console.log('\nRedeploying contracts...');
    execFileSync('npx', ['tsx', 'scripts/deploy.ts', '--network', 'hardhat'], {
        cwd: path.join(root, 'contracts'),
        stdio: 'inherit',
    });

    const deployment = JSON.parse(
        fs.readFileSync(path.join(root, 'contracts', 'deployments', `${LOCAL_CHAIN_ID}.json`), 'utf-8'),
    );

    const envPath = path.join(root, '.env');
    let env = fs.readFileSync(envPath, 'utf-8');
    const addresses: Record<string, string> = {
        AVELON_LENDING_ADDRESS: deployment.avelonLending,
        COLLATERAL_MANAGER_ADDRESS: deployment.collateralManager,
        REPAYMENT_SCHEDULE_ADDRESS: deployment.repaymentSchedule,
        LIQUIDITY_POOL_ADDRESS: deployment.liquidityPool,
        TREASURY_ADDRESS: deployment.deployer,
    };
    for (const [key, value] of Object.entries(addresses)) {
        const line = `${key}="${value}"`;
        env = new RegExp(`^${key}=.*$`, 'm').test(env)
            ? env.replace(new RegExp(`^${key}=.*$`, 'm'), line)
            : `${env}\n${line}\n`;
    }
    fs.writeFileSync(envPath, env);
    console.log('\n.env updated with the new addresses.');
    return addresses;
}

// Deleting every admin would lock everyone out of the web portal
async function checkKeptAdmins(prisma: PrismaClient) {
    const admins = await prisma.user.count({ where: { email: { in: KEEP_ACCOUNTS }, role: 'ADMIN' } });
    if (admins === 0) {
        throw new Error(`Refusing to run: none of ${KEEP_ACCOUNTS.join(', ')} is an admin in this database.`);
    }
}

async function clearTransactionalRows(prisma: PrismaClient) {
    // Order matters — children before parents.
    const counts = {
        loanTransactions: (await prisma.loanTransaction.deleteMany({})).count,
        loans: (await prisma.loan.deleteMany({})).count,
        poolTransactions: (await prisma.poolTransaction.deleteMany({})).count,
        investorDeposits: (await prisma.investorDeposit.deleteMany({})).count,
        liquidityPools: (await prisma.liquidityPool.deleteMany({})).count,
        notifications: (await prisma.notification.deleteMany({})).count,
        auditLogs: (await prisma.auditLog.deleteMany({})).count,
    };

    // The old pool address is meaningless now, and so are the counters that
    // tracked positions in it.
    await prisma.user.updateMany({
        data: { activeLoansCount: 0, completedLoansCount: 0, totalBorrowed: 0, totalRepaid: 0 },
    });

    console.log('\nCleared:');
    for (const [table, count] of Object.entries(counts)) {
        console.log(`  ${count.toString().padStart(4)}  ${table}`);
    }
    console.log('  borrower loan counters reset');
}

// Runs after clearTransactionalRows, which removes the rows that block a user delete
async function deleteAccounts(prisma: PrismaClient) {
    const kept = await prisma.user.findMany({ where: { email: { in: KEEP_ACCOUNTS } }, select: { id: true } });
    const keptIds = new Set(kept.map((u) => u.id));

    // Email codes, password resets and wallet nonces
    const tokens = (await prisma.verificationToken.deleteMany({})).count;
    // Sessions, wallets, documents, preferences and device tokens cascade
    const users = (await prisma.user.deleteMany({ where: { id: { notIn: [...keptIds] } } })).count;

    // One folder per user, holding real ID photos and selfies
    const kycDir = path.resolve(root, process.env.STORAGE_PATH ?? './uploads', 'kyc');
    let folders = 0;
    if (fs.existsSync(kycDir)) {
        for (const name of fs.readdirSync(kycDir)) {
            if (keptIds.has(name)) continue;
            fs.rmSync(path.join(kycDir, name), { recursive: true, force: true });
            folders++;
        }
    }

    // A copy of every email sent in outbox mode, verification codes included
    const outboxDir = path.resolve(root, process.env.EMAIL_OUTBOX_DIR ?? './outbox');
    let emails = 0;
    if (fs.existsSync(outboxDir)) {
        for (const name of fs.readdirSync(outboxDir)) {
            fs.rmSync(path.join(outboxDir, name), { recursive: true, force: true });
            emails++;
        }
    }

    console.log(`  ${users.toString().padStart(4)}  accounts (kept ${KEEP_ACCOUNTS.join(', ')})`);
    console.log(`  ${tokens.toString().padStart(4)}  verification codes and wallet nonces`);
    console.log(`  ${folders.toString().padStart(4)}  KYC upload folders`);
    console.log(`  ${emails.toString().padStart(4)}  outbox files`);
}

async function main() {
    await guard();
    const prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
    });

    try {
        if (wipeAccounts) await checkKeptAdmins(prisma);
        const addresses = redeploy();
        await clearTransactionalRows(prisma);
        if (wipeAccounts) await deleteAccounts(prisma);

        console.log('\nReset complete. Restart the backend so it picks up the new addresses:');
        console.log('  npm run dev');
        console.log(`\nPool: ${addresses.LIQUIDITY_POOL_ADDRESS}`);
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((err) => {
    console.error('\nReset failed:', err.message ?? err);
    process.exit(1);
});
