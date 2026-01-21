import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

const adminPlansRoutes = new Hono();

const createPlanSchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    minCreditScore: z.number().int().min(0).max(100),
    minAmount: z.string(),
    maxAmount: z.string(),
    durationOptions: z.array(z.number().int().positive()),
    interestRate: z.number().positive(),
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
 * List all loan plans
 */
adminPlansRoutes.get('/', async (c) => {
    // TODO: Implement plan listing
    return c.json({
        success: true,
        data: [],
    });
});

/**
 * POST /admin/plans
 * Create a new loan plan
 */
adminPlansRoutes.post('/', zValidator('json', createPlanSchema), async (c) => {
    const body = c.req.valid('json');

    // TODO: Implement plan creation
    return c.json({
        success: true,
        message: 'Plan created',
        data: {
            id: 'new_plan_id',
            ...body,
        },
    }, 201);
});

/**
 * PUT /admin/plans/:id
 * Update a loan plan
 */
adminPlansRoutes.put('/:id', zValidator('json', createPlanSchema.partial()), async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');

    // TODO: Implement plan update
    return c.json({
        success: true,
        message: 'Plan updated',
    });
});

/**
 * DELETE /admin/plans/:id
 * Deactivate a loan plan
 */
adminPlansRoutes.delete('/:id', async (c) => {
    const id = c.req.param('id');

    // TODO: Implement plan deactivation
    return c.json({
        success: true,
        message: 'Plan deactivated',
    });
});

export { adminPlansRoutes };
