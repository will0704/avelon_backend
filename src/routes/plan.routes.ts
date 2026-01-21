import { Hono } from 'hono';

const planRoutes = new Hono();

/**
 * GET /plans
 * List available loan plans (filtered by user's tier)
 */
planRoutes.get('/', async (c) => {
    // TODO: Implement with auth middleware to filter by user's tier
    return c.json({
        success: true,
        data: [
            {
                id: 'plan_starter',
                name: 'Starter',
                description: 'Entry-level loan for new borrowers',
                minCreditScore: 40,
                minAmount: '0.01',
                maxAmount: '0.1',
                durationOptions: [7, 14, 30],
                interestRate: 8,
                collateralRatio: 200,
                originationFee: 2,
                isActive: true,
            },
            {
                id: 'plan_standard',
                name: 'Standard',
                description: 'Standard loan terms for verified borrowers',
                minCreditScore: 60,
                minAmount: '0.05',
                maxAmount: '0.5',
                durationOptions: [14, 30, 60, 90],
                interestRate: 5,
                collateralRatio: 150,
                originationFee: 1.5,
                isActive: true,
            },
            {
                id: 'plan_premium',
                name: 'Premium',
                description: 'Better terms for established borrowers',
                minCreditScore: 80,
                minAmount: '0.1',
                maxAmount: '1.0',
                durationOptions: [30, 60, 90, 180],
                interestRate: 3,
                collateralRatio: 130,
                originationFee: 1,
                isActive: true,
            },
            {
                id: 'plan_vip',
                name: 'VIP',
                description: 'Best terms for VIP borrowers with extension privileges',
                minCreditScore: 90,
                minAmount: '0.2',
                maxAmount: '2.0',
                durationOptions: [30, 60, 90, 180, 365],
                interestRate: 2,
                collateralRatio: 120,
                originationFee: 0.5,
                extensionAllowed: true,
                maxExtensionDays: 30,
                extensionFee: 1,
                isActive: true,
            },
        ],
    });
});

/**
 * GET /plans/:id
 * Get plan details
 */
planRoutes.get('/:id', async (c) => {
    const id = c.req.param('id');

    // TODO: Implement plan lookup
    return c.json({
        success: true,
        data: {
            id,
            name: 'Standard',
            description: 'Standard loan terms for verified borrowers',
            minCreditScore: 60,
            minAmount: '0.05',
            maxAmount: '0.5',
            durationOptions: [14, 30, 60, 90],
            interestRate: 5,
            collateralRatio: 150,
            originationFee: 1.5,
            isActive: true,
        },
    });
});

export { planRoutes };
