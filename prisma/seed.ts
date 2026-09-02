import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { hash } from 'bcrypt';
import { config } from 'dotenv';
import { z } from 'zod';

// Load environment variables
config();

// Create Prisma client with Prisma 7 adapter
const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
});

const prisma = new PrismaClient({ adapter });

const demoSeedConfig = z.object({
    DEMO_SEED_ENABLED: z.literal('true'),
    NODE_ENV: z.enum(['development', 'test']).default('development'),
    DEMO_ADMIN_PASSWORD: z.string().min(12),
    DEMO_BORROWER_PASSWORD: z.string().min(12),
    DEMO_BORROWER_2_PASSWORD: z.string().min(12),
    DEMO_INVESTOR_PASSWORD: z.string().min(12),
    DEMO_INVESTOR_2_PASSWORD: z.string().min(12),
}).safeParse(process.env);

if (!demoSeedConfig.success) {
    throw new Error(
        'Demo seeding is disabled. Set DEMO_SEED_ENABLED=true, use NODE_ENV=development or test, ' +
        'and provide all five DEMO_*_PASSWORD values (minimum 12 characters). Never run this seed against production.'
    );
}

const demoPasswords = demoSeedConfig.data;

/**
 * Hardhat's node hands out the same accounts on every machine, so the demo can bind
 * each role to a known address and skip the signature challenge.
 *
 * This is only ever done on chain 31337. On any other chain a wallet becomes
 * verified solely by signing the challenge, because there a "verified" row the
 * user never signed for would be a real authorisation bypass.
 */
const LOCAL_CHAIN_ID = 31337;
const DEMO_WALLETS: Record<string, { address: string; label: string }> = {
    'borrower@test.com': { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', label: 'Hardhat #1' },
    'borrower2@gmail.com': { address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', label: 'Hardhat #2' },
    'investor@test.com': { address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', label: 'Hardhat #3' },
    'investor2@test.com': { address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', label: 'Hardhat #4' },
};

async function main() {
    console.log('🌱 Seeding database...\n');

    // =====================================================
    // USERS
    // =====================================================

    // Admin
    const adminPassword = await hash(demoPasswords.DEMO_ADMIN_PASSWORD, 12);
    const admin = await prisma.user.upsert({
        where: { email: 'admin@avelon.finance' },
        update: { passwordHash: adminPassword },
        create: {
            email: 'admin@avelon.finance',
            passwordHash: adminPassword,
            name: 'System Admin',
            role: 'ADMIN',
            status: 'APPROVED',
            emailVerified: new Date(),
            kycLevel: 'ENHANCED',
            creditScore: 100,
            creditTier: 'VIP',
        },
    });
    console.log('✅ Created admin:', admin.email);

    // Borrower 1
    const borrower1Password = await hash(demoPasswords.DEMO_BORROWER_PASSWORD, 12);
    const borrower1 = await prisma.user.upsert({
        where: { email: 'borrower@test.com' },
        update: { passwordHash: borrower1Password },
        create: {
            email: 'borrower@test.com',
            passwordHash: borrower1Password,
            name: 'Juan Dela Cruz',
            role: 'BORROWER',
            status: 'APPROVED',
            emailVerified: new Date(),
            kycLevel: 'STANDARD',
            creditScore: 72,
            creditTier: 'STANDARD',
            legalName: 'Juan Dela Cruz',
            address: 'Manila, Philippines',
            monthlyIncome: '50000',
            employmentType: 'EMPLOYED',
        },
    });
    console.log('✅ Created borrower 1:', borrower1.email);

    // Borrower 2
    const borrower2Password = await hash(demoPasswords.DEMO_BORROWER_2_PASSWORD, 12);
    const borrower2 = await prisma.user.upsert({
        where: { email: 'borrower2@gmail.com' },
        update: { passwordHash: borrower2Password },
        create: {
            email: 'borrower2@gmail.com',
            passwordHash: borrower2Password,
            name: 'Maria Santos',
            role: 'BORROWER',
            status: 'APPROVED',
            emailVerified: new Date(),
            kycLevel: 'STANDARD',
            creditScore: 75,
            creditTier: 'STANDARD',
            legalName: 'Maria Santos',
            address: 'Cebu, Philippines',
            monthlyIncome: '60000',
            employmentType: 'EMPLOYED',
        },
    });
    console.log('✅ Created borrower 2:', borrower2.email);

    // Investor
    const investorPassword = await hash(demoPasswords.DEMO_INVESTOR_PASSWORD, 12);
    const investor = await prisma.user.upsert({
        where: { email: 'investor@test.com' },
        update: { passwordHash: investorPassword },
        create: {
            email: 'investor@test.com',
            passwordHash: investorPassword,
            name: 'Demo Investor',
            role: 'INVESTOR',
            status: 'APPROVED',
            emailVerified: new Date(),
            kycLevel: 'ENHANCED',
            creditScore: 90,
            creditTier: 'PREMIUM',
        },
    });
    console.log('✅ Created investor:', investor.email);

    // Investor 2 — a second position proves the pool keeps balances isolated
    const investor2Password = await hash(demoPasswords.DEMO_INVESTOR_2_PASSWORD, 12);
    const investor2 = await prisma.user.upsert({
        where: { email: 'investor2@test.com' },
        update: { passwordHash: investor2Password },
        create: {
            email: 'investor2@test.com',
            passwordHash: investor2Password,
            name: 'Second Investor',
            role: 'INVESTOR',
            status: 'APPROVED',
            emailVerified: new Date(),
            kycLevel: 'ENHANCED',
            creditScore: 88,
            creditTier: 'PREMIUM',
        },
    });
    console.log('✅ Created investor 2:', investor2.email);

    // =====================================================
    // DEMO WALLETS — local chain only
    // =====================================================

    const chainId = Number(process.env.CHAIN_ID ?? 0);
    if (chainId === LOCAL_CHAIN_ID) {
        for (const user of [borrower1, borrower2, investor, investor2]) {
            const demo = DEMO_WALLETS[user.email];
            if (!demo) continue;
            await prisma.wallet.upsert({
                where: { userId_address: { userId: user.id, address: demo.address } },
                update: { isVerified: true, verifiedAt: new Date(), chainId, isPrimary: true, label: demo.label },
                create: {
                    userId: user.id,
                    address: demo.address,
                    chainId,
                    isPrimary: true,
                    isVerified: true,
                    verifiedAt: new Date(),
                    label: demo.label,
                },
            });
            console.log(`✅ Linked ${demo.label} to ${user.email}`);
        }
    } else {
        console.log(`ℹ️  CHAIN_ID is ${chainId || 'unset'}, not ${LOCAL_CHAIN_ID} — no demo wallets seeded.`);
        console.log('   Wallets must be verified by signing the connection challenge.');
    }

    // =====================================================
    // LOAN PLANS
    // =====================================================

    // collateralRatio is the borrower's own stake, not security for the whole debt.
    // An unproven borrower stakes more; a proven one drops to the 35% floor and the
    // credit score carries the rest of the risk.
    const plans = [
        {
            name: 'Starter',
            description: 'Entry-level loan for new borrowers with basic verification',
            minCreditScore: 40,
            minAmount: 0.01,
            maxAmount: 0.1,
            durationOptions: [7, 14, 30],
            interestRate: 8,
            collateralRatio: 60,
            originationFee: 2,
            latePenaltyRate: 0.5,
            gracePeriodDays: 3,
            createdBy: admin.id,
        },
        {
            name: 'Standard',
            description: 'Standard loan terms for verified borrowers with proof of income',
            minCreditScore: 60,
            minAmount: 0.05,
            maxAmount: 0.5,
            durationOptions: [14, 30, 60, 90],
            interestRate: 5,
            collateralRatio: 50,
            originationFee: 1.5,
            latePenaltyRate: 0.5,
            gracePeriodDays: 3,
            createdBy: admin.id,
        },
        {
            name: 'Premium',
            description: 'Better terms for established borrowers with strong repayment history',
            minCreditScore: 80,
            minAmount: 0.1,
            maxAmount: 1.0,
            durationOptions: [30, 60, 90, 180],
            interestRate: 3,
            collateralRatio: 40,
            originationFee: 1,
            latePenaltyRate: 0.5,
            gracePeriodDays: 5,
            createdBy: admin.id,
        },
        {
            name: 'VIP',
            description: 'Best terms for VIP borrowers with loan extension privileges',
            minCreditScore: 90,
            minAmount: 0.2,
            maxAmount: 2.0,
            durationOptions: [30, 60, 90, 180, 365],
            interestRate: 2,
            collateralRatio: 35,
            originationFee: 0.5,
            latePenaltyRate: 0.3,
            gracePeriodDays: 7,
            extensionAllowed: true,
            maxExtensionDays: 30,
            extensionFee: 1,
            createdBy: admin.id,
        },
    ];

    for (const plan of plans) {
        await prisma.loanPlan.upsert({
            where: { name: plan.name },
            update: plan,
            create: plan,
        });
        console.log('✅ Created loan plan:', plan.name);
    }

    // =====================================================
    // LIQUIDITY POOL (singleton — initialize if not present)
    // =====================================================

    const poolCount = await prisma.liquidityPool.count();
    if (poolCount === 0) {
        await prisma.liquidityPool.create({
            data: {
                // Never invent custody. Liquidity is recorded only after a
                // verified deposit operation.
                totalLiquidity: 0,
                totalBorrowed: 0,
                cumulativeYield: 0,
                utilizationRate: 0,
                apy: 0,
            },
        });
        console.log('✅ Initialized empty liquidity pool');
    }

    // =====================================================
    // PRICE HISTORY
    // =====================================================

    await prisma.priceHistory.create({
        data: {
            ethPricePHP: 150000,
            source: 'manual',
        },
    });
    console.log('✅ Created initial price history (1 ETH = ₱150,000)');

    // =====================================================
    // SYSTEM CONFIGS
    // =====================================================

    const configs = [
        { key: 'ETH_PHP_RATE', value: '150000', description: 'Current ETH/PHP exchange rate' },
        { key: 'MIN_COLLATERAL_RATIO', value: '35', description: 'Minimum borrower stake percentage' },
        { key: 'WARNING_COLLATERAL_RATIO', value: '40', description: 'Advisory borrower stake percentage' },
        { key: 'GRACE_PERIOD_HOURS', value: '24', description: 'Grace period before liquidation execution' },
        { key: 'LIQUIDATION_PENALTY_PERCENT', value: '5', description: 'Penalty percentage for liquidation' },
    ];

    for (const cfg of configs) {
        await prisma.systemConfig.upsert({
            where: { key: cfg.key },
            update: { value: cfg.value, description: cfg.description },
            create: cfg,
        });
        console.log('✅ Created system config:', cfg.key);
    }

    // =====================================================
    // SUMMARY
    // =====================================================

    console.log('\n🎉 Local demo seeding completed. Passwords were supplied through the environment and were not printed.\n');
}

main()
    .catch((e) => {
        console.error('❌ Seeding failed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
