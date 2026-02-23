import { Hono } from 'hono';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { NotFoundError } from '../middleware/error.middleware.js';

const planRoutes = new Hono();

// Plan select fields (reusable)
const planSelect = {
    id: true,
    name: true,
    description: true,
    minCreditScore: true,
    minAmount: true,
    maxAmount: true,
    durationOptions: true,
    interestRate: true,
    interestType: true,
    collateralRatio: true,
    originationFee: true,
    latePenaltyRate: true,
    gracePeriodDays: true,
    extensionAllowed: true,
    maxExtensionDays: true,
    extensionFee: true,
    isActive: true,
} as const;

/**
 * GET /plans
 * List available loan plans
 * Optionally filtered by user's credit score when authenticated
 */
planRoutes.get('/', async (c) => {
    // Try to get user context for filtering (auth is optional here)
    let userCreditScore: number | null = null;

    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
        try {
            // Attempt to resolve user — non-blocking
            const jwt = await import('jsonwebtoken');
            const { env } = await import('../config/env.js');
            const token = authHeader.substring(7);
            const payload = jwt.default.verify(token, env.JWT_SECRET) as { userId: string };
            const user = await prisma.user.findUnique({
                where: { id: payload.userId },
                select: { creditScore: true },
            });
            userCreditScore = user?.creditScore ?? null;
        } catch {
            // Ignore auth errors — just return all active plans
        }
    }

    const plans = await prisma.loanPlan.findMany({
        where: { isActive: true },
        select: planSelect,
        orderBy: { minCreditScore: 'asc' },
    });

    // If we know the user's credit score, annotate eligibility
    const data = plans.map((plan: typeof plans[number]) => ({
        ...plan,
        minAmount: Number(plan.minAmount),
        maxAmount: Number(plan.maxAmount),
        eligible: userCreditScore !== null ? userCreditScore >= plan.minCreditScore : null,
    }));

    return c.json({
        success: true,
        data,
        meta: {
            total: data.length,
            userCreditScore,
        },
    });
});

/**
 * GET /plans/:id
 * Get plan details
 */
planRoutes.get('/:id', async (c) => {
    const id = c.req.param('id');

    const plan = await prisma.loanPlan.findUnique({
        where: { id },
        select: {
            ...planSelect,
            createdAt: true,
            updatedAt: true,
            _count: { select: { loans: true } },
        },
    });

    if (!plan) {
        throw new NotFoundError('Loan plan not found');
    }

    return c.json({
        success: true,
        data: {
            ...plan,
            minAmount: Number(plan.minAmount),
            maxAmount: Number(plan.maxAmount),
            totalLoans: plan._count.loans,
        },
    });
});

export { planRoutes };
