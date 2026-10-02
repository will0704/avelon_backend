import { env } from '../config/env.js';

// ETH volatility forecast from the AI service, shared by the admin research page
// and the borrower app. ETH price does not change an ETH/ETH debt ratio, so the
// forecast is advisory and never drives liquidation.

const CACHE_FOR = 15 * 60 * 1000;
// A failure is remembered briefly too: the AI route blocks while it works, so a
// room full of phones retrying at once would queue past the timeout.
const FAILURE_CACHE_FOR = 60 * 1000;
const TIMEOUT = 15_000;

type Baseline = Record<string, any>;

const cache = new Map<number, { expiresAt: number; data: Baseline | null }>();
const inFlight = new Map<number, Promise<Baseline | null>>();

/** Horizon in whole days, 1–30. Anything unparseable falls back to 7. */
export function parseHorizon(raw: string | undefined): number {
    const days = Math.round(Number(raw));
    // FastAPI rejects a fractional horizon with 422, hence the rounding
    if (!raw || !Number.isFinite(days)) return 7;
    return Math.min(30, Math.max(1, days));
}

async function fetchBaseline(horizonDays: number): Promise<Baseline> {
    const url = new URL(`${env.AI_SERVICE_URL}/api/v1/predict/volatility`);
    url.searchParams.set('horizon_days', String(horizonDays));

    const res = await fetch(url, {
        headers: { 'X-API-Key': env.AI_API_KEY },
        signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) throw new Error(`AI service returned ${res.status}`);
    return (await res.json()) as Baseline;
}

// One request per horizon at a time; everyone else waits on the same promise.
function getBaseline(horizonDays: number): Promise<Baseline | null> {
    const cached = cache.get(horizonDays);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.data);

    let pending = inFlight.get(horizonDays);
    if (!pending) {
        pending = fetchBaseline(horizonDays)
            .then((data) => {
                cache.set(horizonDays, { expiresAt: Date.now() + CACHE_FOR, data });
                return data;
            })
            .catch((err) => {
                console.error('[volatility] AI service unavailable:', err instanceof Error ? err.message : err);
                cache.set(horizonDays, { expiresAt: Date.now() + FAILURE_CACHE_FOR, data: null });
                return null;
            })
            .finally(() => inFlight.delete(horizonDays));
        inFlight.set(horizonDays, pending);
    }
    return pending;
}

export async function getVolatilityForecast(horizonDays: number) {
    const baseline = await getBaseline(horizonDays);

    // The AI service being down must not blank a page; clients show a fallback.
    if (!baseline) {
        return { online: false as const, horizonDays, advisoryOnly: true, liquidationEnabled: false };
    }

    return {
        online: true as const,
        horizonDays,
        advisoryOnly: true,
        liquidationEnabled: false,
        economicNote: 'ETH volatility does not change an ETH-collateral/ETH-debt ratio; liquidation is based only on an overdue default.',
        currentPricePHP: baseline.current_price_php,
        priceSource: baseline.price_source,
        model: baseline.model,
        predictedVolatility: baseline.predicted_volatility,
        realizedVolatility24h: baseline.realized_volatility_24h,
        horizonVolatility: baseline.horizon_volatility,
        riskLevel: baseline.risk_level,
        priceRange68: baseline.price_range_68,
        priceRange95: baseline.price_range_95,
        recentPrices: baseline.recent_prices,
        modelMetadata: baseline.model_metadata,
    };
}
