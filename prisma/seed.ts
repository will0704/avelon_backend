import { PrismaClient } from '@prisma/client';
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

    // Create admin user
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
    console.log('✅ Created admin user:', admin.email);

    // Create test borrower
    const borrowerPassword = await hash('Test@123', 12);
    const borrower = await prisma.user.upsert({
        where: { email: 'borrower@test.com' },
        update: {},
        create: {
            email: 'borrower@test.com',
            passwordHash: borrowerPassword,
            name: 'Test Borrower',
            role: 'BORROWER',
            status: 'APPROVED',
            emailVerified: new Date(),
            kycLevel: 'STANDARD',
            creditScore: 72,
            creditTier: 'STANDARD',
            legalName: 'Juan Dela Cruz',
            address: 'Manila, Philippines',
            monthlyIncome: 50000,
            employmentType: 'EMPLOYED',
        },
    });
    console.log('✅ Created test borrower:', borrower.email);

    // Create loan plans
    const plans = [
        {
            name: 'Starter',
            description: 'Entry-level loan for new borrowers with basic verification',
            minCreditScore: 40,
            minAmount: 0.01,
            maxAmount: 0.1,
            durationOptions: [7, 14, 30],
            interestRate: 8,
            collateralRatio: 200,
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
            collateralRatio: 150,
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
            collateralRatio: 130,
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
            collateralRatio: 120,
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

    // Create initial price history
    await prisma.priceHistory.create({
        data: {
            ethPricePHP: 150000,
            source: 'manual',
        },
    });
    console.log('✅ Created initial price history');

    // Create system configs
    const configs = [
        { key: 'ETH_PHP_RATE', value: '150000', description: 'Current ETH/PHP exchange rate' },
        { key: 'MIN_COLLATERAL_RATIO', value: '120', description: 'Minimum collateral ratio before liquidation' },
        { key: 'WARNING_COLLATERAL_RATIO', value: '130', description: 'Collateral ratio to trigger warning' },
        { key: 'GRACE_PERIOD_HOURS', value: '24', description: 'Grace period before liquidation execution' },
        { key: 'LIQUIDATION_PENALTY_PERCENT', value: '5', description: 'Penalty percentage for liquidation' },
    ];

    for (const config of configs) {
        await prisma.systemConfig.upsert({
            where: { key: config.key },
            update: {},
            create: config,
        });
        console.log('✅ Created system config:', config.key);
    }

    console.log('\n🎉 Seeding completed!');
    console.log('\n📝 Test Credentials:');
    console.log('   Admin: admin@avelon.finance / Admin@123');
    console.log('   Borrower: borrower@test.com / Test@123');
}

main()
    .catch((e) => {
        console.error('❌ Seeding failed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
