import { Hono } from 'hono';
import { prisma } from '../../lib/prisma.js';
import { blockchainService } from '../../services/blockchain.service.js';
import { env } from '../../config/env.js';

const adminAnalyticsRoutes = new Hono();

/** Group an array of records into YYYY-MM buckets by createdAt. */
function groupByMonth(records: { createdAt: Date }[]): { month: string; count: number }[] {
    const map = new Map<string, number>();
    for (const r of records) {
        const key = r.createdAt.toISOString().slice(0, 7);
        map.set(key, (map.get(key) ?? 0) + 1);
    }
    return Array.from(map.entries())
        .map(([month, count]) => ({ month, count }))
        .sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * GET /admin/analytics
 * Platform-wide metrics + live treasury balance
 */
adminAnalyticsRoutes.get('/', async (c) => {
    try {
        const [totalUsers, verifiedUsers, approvedUsers, pendingUsers] = await Promise.all([
            prisma.user.count(),
            prisma.user.count({ where: { status: 'VERIFIED' } }),
            prisma.user.count({ where: { status: 'APPROVED' } }),
            prisma.user.count({ where: { status: 'PENDING_KYC' } }),
        ]);

        const [totalLoans, activeLoans, repaidLoans, liquidatedLoans] = await Promise.all([
            prisma.loan.count(),
            prisma.loan.count({ where: { status: 'ACTIVE' } }),
            prisma.loan.count({ where: { status: 'REPAID' } }),
            prisma.loan.count({ where: { status: 'LIQUIDATED' } }),
        ]);

        const loanAggregates = await prisma.loan.aggregate({
            _sum: { principal: true, originationFee: true, interestOwed: true },
        });

        const totalVolume = loanAggregates._sum.principal?.toString() ?? '0';
        const totalFees = loanAggregates._sum.originationFee?.toString() ?? '0';
        const totalInterestEarned = loanAggregates._sum.interestOwed?.toString() ?? '0';

        // Live treasury balance — falls back to null if blockchain is unavailable
        let treasuryBalance: string | null = null;
        if (env.TREASURY_ADDRESS) {
            try {
                treasuryBalance = await blockchainService.getBalance(env.TREASURY_ADDRESS);
            } catch {
                // Blockchain unavailable — omit balance rather than failing the whole endpoint
            }
        }

        const recentLogs = await prisma.auditLog.findMany({
            take: 10,
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                action: true,
                entity: true,
                entityId: true,
                createdAt: true,
                user: { select: { email: true, name: true } },
            },
        });

        const recentActivity = recentLogs.map((log) => {
            const who = log.user?.name ?? log.user?.email ?? 'System';
            const target = log.entity ? ` on ${log.entity}` : '';
            return {
                type: log.action,
                message: `${who} — ${log.action.replace(/_/g, ' ').toLowerCase()}${target}`,
                createdAt: log.createdAt,
            };
        });

        return c.json({
            success: true,
            data: {
                users: { total: totalUsers, verified: verifiedUsers, approved: approvedUsers, pending: pendingUsers },
                loans: { total: totalLoans, active: activeLoans, repaid: repaidLoans, liquidated: liquidatedLoans, totalVolume },
                treasury: { balance: treasuryBalance, totalLent: totalVolume, totalInterestEarned, totalFees },
                recentActivity,
            },
        });
    } catch (error) {
        console.error('Error fetching analytics:', error);
        return c.json({ success: false, error: { message: 'Failed to fetch analytics data' } }, 500);
    }
});

/**
 * GET /admin/analytics/loans
 * Loans broken down by status, plan, and monthly volume
 */
adminAnalyticsRoutes.get('/loans', async (c) => {
    try {
        const statusGroups = await prisma.loan.groupBy({
            by: ['status'],
            _count: { id: true },
            _sum: { principal: true },
        });
        const byStatus = Object.fromEntries(
            statusGroups.map((g) => [g.status, { count: g._count.id, volume: g._sum.principal?.toString() ?? '0' }])
        );

        const planGroups = await prisma.loan.groupBy({
            by: ['planId'],
            _count: { id: true },
            _sum: { principal: true },
        });
        const planIds = planGroups.map((g) => g.planId);
        const plans = await prisma.loanPlan.findMany({
            where: { id: { in: planIds } },
            select: { id: true, name: true },
        });
        const planNameMap = Object.fromEntries(plans.map((p) => [p.id, p.name]));
        const byPlan = Object.fromEntries(
            planGroups.map((g) => [
                planNameMap[g.planId] ?? g.planId,
                { count: g._count.id, volume: g._sum.principal?.toString() ?? '0' },
            ])
        );

        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        const recentLoans = await prisma.loan.findMany({
            where: { createdAt: { gte: sixMonthsAgo } },
            select: { createdAt: true },
        });
        const volumeByMonth = groupByMonth(recentLoans);

        return c.json({ success: true, data: { byStatus, byPlan, volumeByMonth } });
    } catch (error) {
        console.error('Error fetching loan analytics:', error);
        return c.json({ success: false, error: { message: 'Failed to fetch loan analytics' } }, 500);
    }
});

/**
 * GET /admin/analytics/users
 * Users broken down by status, credit tier, and monthly registrations
 */
adminAnalyticsRoutes.get('/users', async (c) => {
    try {
        const statusGroups = await prisma.user.groupBy({
            by: ['status'],
            _count: { id: true },
        });
        const byStatus = Object.fromEntries(statusGroups.map((g) => [g.status, g._count.id]));

        const tierGroups = await prisma.user.groupBy({
            by: ['creditTier'],
            _count: { id: true },
        });
        const byTier = Object.fromEntries(tierGroups.map((g) => [g.creditTier ?? 'NONE', g._count.id]));

        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        const recentUsers = await prisma.user.findMany({
            where: { createdAt: { gte: sixMonthsAgo } },
            select: { createdAt: true },
        });
        const registrationsByMonth = groupByMonth(recentUsers);

        return c.json({ success: true, data: { byStatus, byTier, registrationsByMonth } });
    } catch (error) {
        console.error('Error fetching user analytics:', error);
        return c.json({ success: false, error: { message: 'Failed to fetch user analytics' } }, 500);
    }
});

export { adminAnalyticsRoutes };
