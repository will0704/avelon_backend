import { Hono } from 'hono';
import { zValidator } from '../../lib/validate.js';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { blockchainService } from '../../services/blockchain.service.js';
import { emailService } from '../../services/email.service.js';
import { isLocalChain, now, syncClock, clockOffsetMs } from '../../lib/clock.js';
import { ForbiddenError, NotFoundError } from '../../middleware/error.middleware.js';
import { JOBS, runAllJobs, type JobName } from '../../jobs/index.js';
import { PRICE_OVERRIDE_KEY } from '../../jobs/price-feed.job.js';
import { currentEthPrice } from '../../jobs/risk-monitor.job.js';

/**
 * Demo controls for a local run: move the ETH price, fast-forward the Hardhat
 * clock and run the loan jobs on demand, so margin calls, reminders, overdue
 * loans, expiry and liquidation can be shown without waiting days. Admin-only,
 * and refused unless the server runs in development against chain 31337, so it
 * can never touch a real network.
 */
const adminDevRoutes = new Hono();

const devToolsEnabled = () => env.NODE_ENV === 'development' && isLocalChain();

adminDevRoutes.use('*', async (c, next) => {
    if (!devToolsEnabled()) {
        throw new ForbiddenError('Demo controls only run on a local development server with the Hardhat chain');
    }
    await next();
});

/** GET /admin/dev/state */
adminDevRoutes.get('/state', async (c) => {
    await syncClock();
    const held = await prisma.systemConfig.findUnique({ where: { key: PRICE_OVERRIDE_KEY } });
    return c.json({
        success: true,
        data: {
            enabled: true,
            chainTime: now().toISOString(),
            offsetMs: clockOffsetMs(),
            ethPricePHP: await currentEthPrice(),
            priceHeld: held?.value === 'true',
            emailDelivery: emailService.delivery,
            jobs: Object.keys(JOBS),
        },
    });
});

const priceSchema = z.object({
    price: z.number().positive().max(100_000_000),
    runRiskMonitor: z.boolean().default(true),
});

/**
 * POST /admin/dev/price
 * Set ETH/PHP and hold it against the hourly feed, then check for margin calls.
 */
adminDevRoutes.post('/price', zValidator('json', priceSchema), async (c) => {
    const { price, runRiskMonitor } = c.req.valid('json');
    const adminId = c.get('userId' as never) as string;

    await prisma.$transaction([
        prisma.systemConfig.upsert({
            where: { key: 'ETH_PHP_RATE' },
            update: { value: price.toFixed(2), updatedBy: adminId },
            create: { key: 'ETH_PHP_RATE', value: price.toFixed(2), description: 'ETH/PHP rate', updatedBy: adminId },
        }),
        prisma.systemConfig.upsert({
            where: { key: PRICE_OVERRIDE_KEY },
            update: { value: 'true', updatedBy: adminId },
            create: { key: PRICE_OVERRIDE_KEY, value: 'true', description: 'Demo price held against the feed', updatedBy: adminId },
        }),
        prisma.priceHistory.create({ data: { ethPricePHP: price, source: 'manual' } }),
        prisma.auditLog.create({
            data: { userId: adminId, action: 'DEMO_PRICE_SET', entity: 'SystemConfig', entityId: 'ETH_PHP_RATE', metadata: { price } },
        }),
    ]);

    const marginCalls = runRiskMonitor ? await JOBS['risk-monitor']() : 0;
    return c.json({ success: true, message: `ETH/PHP held at ${price}`, data: { ethPricePHP: price, marginCalls } });
});

/** POST /admin/dev/price/release — hand the price back to the hourly feed */
adminDevRoutes.post('/price/release', async (c) => {
    await prisma.systemConfig.deleteMany({ where: { key: PRICE_OVERRIDE_KEY } });
    return c.json({ success: true, message: 'The hourly price feed sets the price again from its next run' });
});

const forwardSchema = z.object({
    days: z.number().min(0).max(400).default(0),
    hours: z.number().min(0).max(24 * 400).default(0),
    runJobs: z.boolean().default(true),
}).refine((v) => v.days > 0 || v.hours > 0, { message: 'Move the clock forward by at least an hour' });

/**
 * POST /admin/dev/fast-forward
 * Advance the Hardhat clock, mine a block, and run every loan job against the new time.
 */
adminDevRoutes.post('/fast-forward', zValidator('json', forwardSchema), async (c) => {
    const { days, hours, runJobs } = c.req.valid('json');
    const adminId = c.get('userId' as never) as string;
    const seconds = Math.round(days * 86400 + hours * 3600);

    const provider = blockchainService.getProvider();
    await provider.send('evm_increaseTime', [seconds]);
    await provider.send('evm_mine', []);
    await syncClock();

    await prisma.auditLog.create({
        data: { userId: adminId, action: 'DEMO_TIME_FORWARDED', entity: 'Chain', metadata: { seconds, chainTime: now().toISOString() } },
    });

    const jobs = runJobs ? await runAllJobs() : null;
    return c.json({
        success: true,
        message: `Chain clock moved forward ${days ? `${days} day(s) ` : ''}${hours ? `${hours} hour(s)` : ''}`.trim(),
        data: { chainTime: now().toISOString(), offsetMs: clockOffsetMs(), jobs },
    });
});

/** POST /admin/dev/jobs/:name — run one job now, or "all" */
adminDevRoutes.post('/jobs/:name', async (c) => {
    const name = c.req.param('name');
    if (name === 'all') {
        return c.json({ success: true, data: await runAllJobs() });
    }
    if (!(name in JOBS)) throw new NotFoundError(`No job called ${name}`);
    const count = await JOBS[name as JobName]();
    return c.json({ success: true, data: { [name]: count } });
});

/** GET /admin/dev/outbox — emails written by EMAIL_DELIVERY=outbox, newest first */
adminDevRoutes.get('/outbox', async (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
    const to = c.req.query('to');
    const entries = await emailService.listOutbox(500);
    const filtered = to ? entries.filter((e) => e.to.toLowerCase() === to.toLowerCase()) : entries;
    return c.json({ success: true, data: filtered.slice(0, limit), meta: { delivery: emailService.delivery } });
});

/** GET /admin/dev/outbox/:id — the email itself, as HTML */
adminDevRoutes.get('/outbox/:id', async (c) => {
    const html = await emailService.readOutbox(c.req.param('id'));
    if (!html) throw new NotFoundError('Email not found');
    return c.html(html);
});

export { adminDevRoutes, devToolsEnabled };
