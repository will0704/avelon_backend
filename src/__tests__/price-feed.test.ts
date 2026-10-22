/**
 * ETH/PHP price feed: which CoinGecko points become PriceHistory rows, and when the
 * job writes nothing at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// MUST be first — registers Prisma mock before any module resolves
import './prisma.mock.js';
import { mockPrismaClient } from './prisma.mock.js';

const { newHourlyBars, syncEthPhpPrices } = await import('../jobs/price-feed.job.js');

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 2, 4, 36, 10);
const TOP_OF_HOUR = Date.UTC(2026, 9, 2, 4);

// Three closed hours plus the live point, the shape CoinGecko returns
function series(): [number, number][] {
    return [
        [TOP_OF_HOUR - 2 * HOUR, 168000.1],
        [TOP_OF_HOUR - HOUR, 169000.2],
        [TOP_OF_HOUR, 170000.3],
        [NOW, 171348.4],
    ];
}

function respondWith(body: unknown, status = 200) {
    const fetchMock = vi.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mockPrismaClient.priceHistory.findFirst = vi.fn().mockResolvedValue(null);
    mockPrismaClient.systemConfig.findUnique = vi.fn().mockResolvedValue(null);
    (mockPrismaClient as Record<string, unknown>).$transaction = vi.fn().mockResolvedValue([]);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('newHourlyBars', () => {
    it('drops the live point and anything not newer than the last stored bar', () => {
        const bars = newHourlyBars(series(), TOP_OF_HOUR - 2 * HOUR);

        expect(bars.map(([t]) => t)).toEqual([TOP_OF_HOUR - HOUR, TOP_OF_HOUR]);
    });

    it('drops prices that are not positive numbers', () => {
        const bars = newHourlyBars(
            [[1 * HOUR, Number.NaN], [2 * HOUR, 0], [3 * HOUR, -5], [4 * HOUR, 170000], [5 * HOUR, 171000]],
            0,
        );

        expect(bars).toEqual([[4 * HOUR, 170000]]);
    });
});

describe('syncEthPhpPrices', () => {
    it('backfills 90 days on an empty table and sets the live rate', async () => {
        const fetchMock = respondWith({ prices: series() });

        const result = await syncEthPhpPrices();

        expect(String(fetchMock.mock.calls[0][0])).toMatch(/days=90$/);
        expect(result).toEqual({ added: 3, price: 171348.4 });
        const rows = vi.mocked(mockPrismaClient.priceHistory.createMany).mock.calls[0][0].data;
        expect(rows).toHaveLength(3);
        expect(rows[0]).toEqual({
            ethPricePHP: '168000.10',
            source: 'coingecko',
            createdAt: new Date(TOP_OF_HOUR - 2 * HOUR),
        });
        expect(mockPrismaClient.systemConfig.upsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { key: 'ETH_PHP_RATE' },
            update: { value: '171348.40', updatedBy: 'coingecko' },
        }));
    });

    it('only adds the hours since the newest stored bar', async () => {
        mockPrismaClient.priceHistory.findFirst = vi.fn()
            .mockResolvedValue({ createdAt: new Date(TOP_OF_HOUR - HOUR) });
        const fetchMock = respondWith({ prices: series() });

        const result = await syncEthPhpPrices();

        // Two days is the shortest window CoinGecko still answers hourly
        expect(String(fetchMock.mock.calls[0][0])).toMatch(/days=2$/);
        expect(result?.added).toBe(1);
        const rows = vi.mocked(mockPrismaClient.priceHistory.createMany).mock.calls[0][0].data;
        expect(rows.map((r: { createdAt: Date }) => r.createdAt.getTime())).toEqual([TOP_OF_HOUR]);
    });

    it('writes nothing when CoinGecko rate-limits the request', async () => {
        respondWith({ status: { error_code: 429 } }, 429);

        const result = await syncEthPhpPrices();

        expect(result).toEqual({ added: 0, price: null });
        expect(mockPrismaClient.$transaction).not.toHaveBeenCalled();
    });

    it('throws on any other HTTP failure without writing', async () => {
        respondWith({}, 500);

        await expect(syncEthPhpPrices()).rejects.toThrow('CoinGecko returned HTTP 500');
        expect(mockPrismaClient.$transaction).not.toHaveBeenCalled();
    });

    it('keeps the stored rate when the live price is not a usable number', async () => {
        const prices = series();
        prices[prices.length - 1][1] = Number.NaN;
        respondWith({ prices });

        const result = await syncEthPhpPrices();

        expect(result).toEqual({ added: 3, price: null });
        expect(mockPrismaClient.systemConfig.upsert).not.toHaveBeenCalled();
    });

    it('skips the boot fetch when the rate was updated minutes ago', async () => {
        mockPrismaClient.systemConfig.findUnique = vi.fn()
            .mockResolvedValue({ key: 'ETH_PHP_RATE', value: '171000', updatedAt: new Date(NOW - 60_000) });
        const fetchMock = respondWith({ prices: series() });

        const result = await syncEthPhpPrices({ skipIfFresh: true });

        expect(result).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
