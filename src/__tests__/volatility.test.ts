/**
 * Volatility forecast shared by /admin/volatility and /market/volatility: field
 * mapping, caching, and what callers get when the AI service is down.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config/env.js', () => ({
    env: { AI_SERVICE_URL: 'http://ai.test', AI_API_KEY: 'test-key' },
}));

const BASELINE = {
    horizon_days: 7,
    current_price_php: 171348.4,
    price_source: 'coingecko',
    model: 'lstm',
    predicted_volatility: 0.62,
    realized_volatility_24h: 0.55,
    horizon_volatility: 0.0857,
    risk_level: 'MODERATE',
    price_range_68: { lower: 157270.1, upper: 186684.2 },
    price_range_95: { lower: 144356.3, upper: 203381.9 },
    liquidation: { stake_ratio_bps: 3500 },
    recent_prices: [170000, 171000],
    model_metadata: { mae: 0.01 },
    advisory_only: true,
};

function respondWith(body: unknown, ok = true) {
    const fetchMock = vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 503, json: async () => body });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

// Fresh module per test, so the cache from one test cannot answer the next
async function load() {
    vi.resetModules();
    return import('../services/volatility.service.js');
}

beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('parseHorizon', () => {
    it('defaults to 7 days for anything unparseable', async () => {
        const { parseHorizon } = await load();
        for (const raw of [undefined, '', 'abc', 'NaN']) {
            expect(parseHorizon(raw)).toBe(7);
        }
    });

    it('rounds and clamps to 1–30 days', async () => {
        const { parseHorizon } = await load();
        expect(parseHorizon('7.5')).toBe(8);
        expect(parseHorizon('0')).toBe(1);
        expect(parseHorizon('-3')).toBe(1);
        expect(parseHorizon('99')).toBe(30);
    });
});

describe('getVolatilityForecast', () => {
    it('maps the AI response and marks it advisory', async () => {
        const fetchMock = respondWith(BASELINE);
        const { getVolatilityForecast } = await load();

        const forecast = await getVolatilityForecast(7);

        const url = new URL(String(fetchMock.mock.calls[0][0]));
        expect(url.pathname).toBe('/api/v1/predict/volatility');
        expect(url.searchParams.get('horizon_days')).toBe('7');
        expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'X-API-Key': 'test-key' });
        expect(forecast).toMatchObject({
            online: true,
            horizonDays: 7,
            advisoryOnly: true,
            liquidationEnabled: false,
            model: 'lstm',
            riskLevel: 'MODERATE',
            horizonVolatility: 0.0857,
            priceRange68: { lower: 157270.1, upper: 186684.2 },
            priceSource: 'coingecko',
        });
        // The legacy terminal-price scenario is not passed on
        expect('liquidation' in forecast).toBe(false);
    });

    it('serves repeat calls from the cache', async () => {
        const fetchMock = respondWith(BASELINE);
        const { getVolatilityForecast } = await load();

        await getVolatilityForecast(7);
        await getVolatilityForecast(7);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('makes one request when many callers arrive together', async () => {
        const fetchMock = respondWith(BASELINE);
        const { getVolatilityForecast } = await load();

        const results = await Promise.all([1, 2, 3, 4, 5].map(() => getVolatilityForecast(7)));

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(results.every((r) => r.online)).toBe(true);
    });

    it('reports offline when the AI service fails, and does not retry at once', async () => {
        const fetchMock = respondWith({}, false);
        const { getVolatilityForecast } = await load();

        const first = await getVolatilityForecast(7);
        const second = await getVolatilityForecast(7);

        expect(first).toEqual({ online: false, horizonDays: 7, advisoryOnly: true, liquidationEnabled: false });
        expect(second.online).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
