import { prisma } from '../lib/prisma.js';

// CoinGecko's free endpoint, no key. Asking for 2–90 days returns one point per
// hour, on the hour, followed by a final point at the live price.
const COINGECKO = 'https://api.coingecko.com/api/v3/coins/ethereum/market_chart?vs_currency=php&days=';
const SOURCE = 'coingecko';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_DAYS = 90;
// tsx watch restarts the server on every save; one fetch per ten minutes is plenty
const FRESH_FOR = 10 * 60 * 1000;

let isRunning = false;

type Point = [timestampMs: number, pricePHP: number];

const isPrice = (p: unknown): p is number => typeof p === 'number' && Number.isFinite(p) && p > 0;

// Hourly bars newer than the last stored one. The final point is the live price
// part-way through an hour, so it sets the current rate but is never stored as a bar.
export function newHourlyBars(prices: Point[], sinceMs: number): Point[] {
    return prices.slice(0, -1).filter(([t, p]) => t > sinceMs + HOUR / 2 && isPrice(p));
}

// Fills PriceHistory up to the last full hour and sets ETH_PHP_RATE to the live
// price. The gap since the newest stored bar is backfilled, so a server that was
// down or asleep catches up on its next run.
export async function syncEthPhpPrices(
    { skipIfFresh = false }: { skipIfFresh?: boolean } = {},
): Promise<{ added: number; price: number | null } | null> {
    if (isRunning) return null;
    isRunning = true;

    try {
        const now = Date.now();
        if (skipIfFresh) {
            const rate = await prisma.systemConfig.findUnique({ where: { key: 'ETH_PHP_RATE' } });
            if (rate && now - rate.updatedAt.getTime() < FRESH_FOR) return null;
        }

        const last = await prisma.priceHistory.findFirst({
            where: { source: SOURCE },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
        });
        const since = last ? last.createdAt.getTime() : now - MAX_DAYS * DAY;
        const days = Math.min(MAX_DAYS, Math.max(2, Math.ceil((now - since) / DAY) + 1));

        const res = await fetch(COINGECKO + days, { signal: AbortSignal.timeout(15_000) });
        if (res.status === 429) {
            console.warn('[PriceFeed] CoinGecko rate limit reached; retrying next hour');
            return { added: 0, price: null };
        }
        if (!res.ok) throw new Error(`CoinGecko returned HTTP ${res.status}`);

        const body = (await res.json()) as { prices?: Point[] };
        const prices = Array.isArray(body.prices) ? body.prices : [];
        const bars = newHourlyBars(prices, since);
        const live = prices.at(-1)?.[1];
        // A NaN rate would break every loan application, which reads it as a Decimal
        const price = isPrice(live) ? Number(live.toFixed(2)) : null;
        if (bars.length === 0 && price === null) return { added: 0, price: null };

        await prisma.$transaction([
            prisma.priceHistory.createMany({
                data: bars.map(([t, p]) => ({ ethPricePHP: p.toFixed(2), source: SOURCE, createdAt: new Date(t) })),
            }),
            ...(price === null
                ? []
                : [
                      prisma.systemConfig.upsert({
                          where: { key: 'ETH_PHP_RATE' },
                          update: { value: price.toFixed(2), updatedBy: SOURCE },
                          create: { key: 'ETH_PHP_RATE', value: price.toFixed(2), description: 'ETH/PHP rate', updatedBy: SOURCE },
                      }),
                  ]),
        ]);

        return { added: bars.length, price };
    } finally {
        isRunning = false;
    }
}
