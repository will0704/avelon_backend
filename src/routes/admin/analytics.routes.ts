import { Hono } from 'hono';

import { prisma } from '../../lib/prisma.js';

const adminAnalyticsRoutes = new Hono();

/**
 * GET /admin/analytics
 * Get platform analytics
 */
adminAnalyticsRoutes.get('/', async (c) => {
    try {
        // Users Metrics
        const [totalUsers, verifiedUsers, approvedUsers, pendingUsers] = await Promise.all([
            prisma.user.count(),
            prisma.user.count({ where: { status: 'VERIFIED' } }),
            prisma.user.count({ where: { status: 'APPROVED' } }),
            prisma.user.count({ where: { status: 'PENDING_KYC' } }),
        ]);

        // Loans Metrics
        const [totalLoans, activeLoans, repaidLoans, liquidatedLoans] = await Promise.all([
            prisma.loan.count(),
            prisma.loan.count({ where: { status: 'ACTIVE' } }),
            prisma.loan.count({ where: { status: 'REPAID' } }),
            prisma.loan.count({ where: { status: 'LIQUIDATED' } }),
        ]);

        // Aggregate volume (Sum of all principal)
        const loanAggregates = await prisma.loan.aggregate({
            _sum: {
                principal: true,
                originationFee: true,
                interestOwed: true,
            }
        });

        // Sum of disbursed loans (could conditionally filter by status if preferred)
        const totalVolume = loanAggregates._sum.principal?.toString() || '0';
        const totalFees = loanAggregates._sum.originationFee?.toString() || '0';
        const totalInterestEarned = loanAggregates._sum.interestOwed?.toString() || '0';

        // Get 5 most recent audit logs for recent activity
        const recentActivity = await prisma.auditLog.findMany({
            take: 5,
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                action: true,
                entity: true,
                entityId: true,
                createdAt: true,
                user: { select: { email: true, name: true } }
            }
        });

        return c.json({
            success: true,
            data: {
                users: {
                    total: totalUsers,
                    verified: verifiedUsers,
                    approved: approvedUsers,
                    pending: pendingUsers,
                },
                loans: {
                    total: totalLoans,
                    active: activeLoans,
                    repaid: repaidLoans,
                    liquidated: liquidatedLoans,
                    totalVolume,
                },
                treasury: {
                    balance: '10.0', // TODO: implement accurate treasury pool balance tracker
                    totalLent: totalVolume,
                    totalInterestEarned,
                    totalFees,
                },
                recentActivity,
            },
        });
    } catch (error) {
        console.error('Error fetching analytics:', error);
        return c.json({
            success: false,
            error: {
                message: 'Failed to fetch analytics data'
            }
        }, 500);
    }
});

/**
 * GET /admin/analytics/loans
 * Get loan analytics
 */
adminAnalyticsRoutes.get('/loans', async (c) => {
    // TODO: Implement loan analytics
    return c.json({
        success: true,
        data: {
            byStatus: {},
            byPlan: {},
            volumeByMonth: [],
        },
    });
});

/**
 * GET /admin/analytics/users
 * Get user analytics
 */
adminAnalyticsRoutes.get('/users', async (c) => {
    // TODO: Implement user analytics
    return c.json({
        success: true,
        data: {
            byStatus: {},
            byTier: {},
            registrationsbyMonth: [],
        },
    });
});

export { adminAnalyticsRoutes };
