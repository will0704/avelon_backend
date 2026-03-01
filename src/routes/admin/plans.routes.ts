import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';

const adminPlansRoutes = new Hono();

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
    createdAt: true,
    updatedAt: true,
    createdBy: true,
    _count: { select: { loans: true } },
} as const;

// Accept both number and string for amount fields (frontend sends number, schema stores Decimal)
const createPlanSchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    minCreditScore: z.number().int().min(0).max(100),
    minAmount: z.union([z.string(), z.number()]).transform(String),
    maxAmount: z.union([z.string(), z.number()]).transform(String),
    durationOptions: z.array(z.number().int().positive()),
    interestRate: z.number().positive(),
    interestType: z.enum(['FLAT', 'COMPOUND']).default('FLAT'),
    collateralRatio: z.number().positive(),
    originationFee: z.number().min(0),
    latePenaltyRate: z.number().min(0).default(0.5),
    gracePeriodDays: z.number().int().min(0).default(3),
    extensionAllowed: z.boolean().default(false),
    maxExtensionDays: z.number().int().min(0).default(0),
    extensionFee: z.number().min(0).default(0),
});

/**
 * GET /admin/plans
 * List all loan plans (including inactive)
 */
adminPlansRoutes.get('/', async (c) => {
    try {
        const plans = await prisma.loanPlan.findMany({
            select: planSelect,
            orderBy: { createdAt: 'desc' },
        });

        const mapped = plans.map((plan) => ({
            ...plan,
            minAmount: Number(plan.minAmount),
            maxAmount: Number(plan.maxAmount),
            totalLoans: plan._count.loans,
            _count: undefined,
        }));

        return c.json({
            success: true,
            data: { plans: mapped },
        });
    } catch (err) {
        console.error('[admin/plans] list error:', err);
        return c.json({ success: false, message: 'Failed to fetch plans' }, 500);
    }
});

/**
 * POST /admin/plans
 * Create a new loan plan
 */
adminPlansRoutes.post('/', zValidator('json', createPlanSchema), async (c) => {
    try {
        const body = c.req.valid('json');
        const createdBy = (c.get('userId' as never) as string) ?? 'system';

        const plan = await prisma.loanPlan.create({
            data: {
                name: body.name,
                description: body.description,
                minCreditScore: body.minCreditScore,
                minAmount: body.minAmount,
                maxAmount: body.maxAmount,
                durationOptions: body.durationOptions,
                interestRate: body.interestRate,
                interestType: body.interestType,
                collateralRatio: body.collateralRatio,
                originationFee: body.originationFee,
                latePenaltyRate: body.latePenaltyRate,
                gracePeriodDays: body.gracePeriodDays,
                extensionAllowed: body.extensionAllowed,
                maxExtensionDays: body.maxExtensionDays,
                extensionFee: body.extensionFee,
                createdBy,
            },
            select: planSelect,
        }) as any;

        return c.json({
            success: true,
            message: 'Plan created',
            data: {
                ...plan,
                minAmount: Number(plan.minAmount),
                maxAmount: Number(plan.maxAmount),
                totalLoans: plan._count.loans,
                _count: undefined,
            },
        }, 201);
    } catch (err: any) {
        console.error('[admin/plans] create error:', err);
        if (err?.code === 'P2002') {
            return c.json({ success: false, message: 'A plan with that name already exists' }, 409);
        }
        return c.json({ success: false, message: 'Failed to create plan' }, 500);
    }
});

/**
 * PUT /admin/plans/:id
 * Update a loan plan
 */
adminPlansRoutes.put('/:id', zValidator('json', createPlanSchema.partial()), async (c) => {
    try {
        const id = c.req.param('id');
        const body = c.req.valid('json');

        const existing = await prisma.loanPlan.findUnique({ where: { id } });
        if (!existing) {
            return c.json({ success: false, message: 'Plan not found' }, 404);
        }

        const plan = await prisma.loanPlan.update({
            where: { id },
            data: body as any,
            select: planSelect,
        }) as any;

        return c.json({
            success: true,
            message: 'Plan updated',
            data: {
                ...plan,
                minAmount: Number(plan.minAmount),
                maxAmount: Number(plan.maxAmount),
                totalLoans: plan._count.loans,
                _count: undefined,
            },
        });
    } catch (err: any) {
        console.error('[admin/plans] update error:', err);
        if (err?.code === 'P2002') {
            return c.json({ success: false, message: 'A plan with that name already exists' }, 409);
        }
        return c.json({ success: false, message: 'Failed to update plan' }, 500);
    }
});

/**
 * DELETE /admin/plans/:id
 * Deactivate a loan plan (soft delete)
 */
adminPlansRoutes.delete('/:id', async (c) => {
    try {
        const id = c.req.param('id');

        const existing = await prisma.loanPlan.findUnique({ where: { id } });
        if (!existing) {
            return c.json({ success: false, message: 'Plan not found' }, 404);
        }

        // Soft delete — mark as inactive rather than removing
        await prisma.loanPlan.update({
            where: { id },
            data: { isActive: false },
        });

        return c.json({
            success: true,
            message: 'Plan deactivated',
        });
    } catch (err) {
        console.error('[admin/plans] delete error:', err);
        return c.json({ success: false, message: 'Failed to deactivate plan' }, 500);
    }
});

/**
 * DELETE /admin/plans/:id/permanent
 * Permanently delete a loan plan (hard delete).
 * Only allowed when the plan has zero associated loans.
 */
adminPlansRoutes.delete('/:id/permanent', async (c) => {
    try {
        const id = c.req.param('id');

        const existing = await prisma.loanPlan.findUnique({
            where: { id },
            include: { _count: { select: { loans: true } } },
        });

        if (!existing) {
            return c.json({ success: false, message: 'Plan not found' }, 404);
        }

        if (existing._count.loans > 0) {
            return c.json(
                {
                    success: false,
                    message: `Cannot delete plan — it has ${existing._count.loans} associated loan(s). Deactivate it instead.`,
                },
                409,
            );
        }

        await prisma.loanPlan.delete({ where: { id } });

        return c.json({ success: true, message: 'Plan permanently deleted' });
    } catch (err) {
        console.error('[admin/plans] permanent delete error:', err);
        return c.json({ success: false, message: 'Failed to delete plan' }, 500);
    }
});

export { adminPlansRoutes };
