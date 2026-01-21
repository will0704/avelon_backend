import { Hono } from 'hono';

const adminKycRoutes = new Hono();

/**
 * GET /admin/kyc/pending
 * List pending KYC reviews
 */
adminKycRoutes.get('/pending', async (c) => {
    // TODO: Implement pending KYC listing
    return c.json({
        success: true,
        data: [],
        meta: {
            total: 0,
        },
    });
});

/**
 * PUT /admin/kyc/:userId/approve
 * Approve user's KYC
 */
adminKycRoutes.put('/:userId/approve', async (c) => {
    const userId = c.req.param('userId');
    const { creditScore, tier } = await c.req.json();

    // TODO: Implement KYC approval
    return c.json({
        success: true,
        message: 'KYC approved',
        data: {
            userId,
            creditScore,
            tier,
        },
    });
});

/**
 * PUT /admin/kyc/:userId/reject
 * Reject user's KYC
 */
adminKycRoutes.put('/:userId/reject', async (c) => {
    const userId = c.req.param('userId');
    const { reason } = await c.req.json();

    // TODO: Implement KYC rejection
    return c.json({
        success: true,
        message: 'KYC rejected',
        data: {
            userId,
            reason,
        },
    });
});

export { adminKycRoutes };
