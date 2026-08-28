import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { hash } from 'bcrypt';
import { config } from 'dotenv';

// Load environment variables
config();

// Create Prisma client with Prisma 7 adapter
const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
});

const prisma = new PrismaClient({ adapter });

async function main() {
    console.log('🌱 Seeding database...\n');

    // =====================================================
    // USERS
    // =====================================================

    // Admin
    const adminPassword = await hash('Admin@123', 12);
    const admin = await prisma.user.upsert({
        where: { email: 'admin@avelon.finance' },
        update: {},
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
    const borrower1Password = await hash('Borrower@123', 12);
    const borrower1 = await prisma.user.upsert({
        where: { email: 'borrower@test.com' },
        update: {},
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
    const borrower2Password = await hash('Borrower2@123', 12);
    const borrower2 = await prisma.user.upsert({
        where: { email: 'borrower2@gmail.com' },
        update: {},
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
    const investorPassword = await hash('Investor@123', 12);
    const investor = await prisma.user.upsert({
        where: { email: 'investor@test.com' },
        update: {},
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
            update: {},
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
                totalLiquidity: 2.0,   // 2 ETH demo liquidity
                totalBorrowed: 0,
                cumulativeYield: 0,
                utilizationRate: 0,
                apy: 0,
            },
        });
        console.log('✅ Initialized liquidity pool (2 ETH)');
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
        { key: 'MIN_COLLATERAL_RATIO', value: '120', description: 'Minimum collateral ratio before liquidation' },
        { key: 'WARNING_COLLATERAL_RATIO', value: '130', description: 'Collateral ratio to trigger warning' },
        { key: 'GRACE_PERIOD_HOURS', value: '24', description: 'Grace period before liquidation execution' },
        { key: 'LIQUIDATION_PENALTY_PERCENT', value: '5', description: 'Penalty percentage for liquidation' },
    ];

    for (const cfg of configs) {
        await prisma.systemConfig.upsert({
            where: { key: cfg.key },
            update: {},
            create: cfg,
        });
        console.log('✅ Created system config:', cfg.key);
    }

    // =====================================================
    // SUMMARY
    // =====================================================

    console.log('\n🎉 Seeding completed!\n');
    console.log('📝 Demo Accounts:');
    console.log('┌─────────────────────────────────────────────────────┐');
    console.log('│  Role      │ Email                  │ Password       │');
    console.log('├─────────────────────────────────────────────────────┤');
    console.log('│  ADMIN     │ admin@avelon.finance    │ Admin@123      │');
    console.log('│  BORROWER  │ borrower@test.com       │ Borrower@123   │');
    console.log('│  BORROWER  │ borrower2@gmail.com     │ Borrower2@123  │');
    console.log('│  INVESTOR  │ investor@test.com       │ Investor@123   │');
    console.log('└─────────────────────────────────────────────────────┘');
}

main()
    .catch((e) => {
        console.error('❌ Seeding failed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
