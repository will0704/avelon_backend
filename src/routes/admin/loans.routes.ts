import { Hono } from 'hono';

const adminLoansRoutes = new Hono();

/**
 * GET /admin/loans
 * List all loans
 */
adminLoansRoutes.get('/', async (c) => {
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '20');
    const status = c.req.query('status');

    // TODO: Implement loan listing
    return c.json({
        success: true,
        data: [],
        meta: {
            total: 0,
            page,
            limit,
            totalPages: 0,
        },
    });
});

/**
 * GET /admin/loans/:id
 * Get loan details
 */
adminLoansRoutes.get('/:id', async (c) => {
    const id = c.req.param('id');

    // TODO: Implement loan lookup
    return c.json({
        success: true,
        data: null,
    });
});

/**
 * POST /admin/loans/:id/liquidate
 * Manually trigger liquidation
 */
adminLoansRoutes.post('/:id/liquidate', async (c) => {
    const id = c.req.param('id');

    // TODO: Implement manual liquidation
    return c.json({
        success: true,
        message: 'Liquidation triggered',
    });
});

export { adminLoansRoutes };
