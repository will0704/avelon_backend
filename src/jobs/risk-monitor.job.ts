import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';
import { now, syncClock } from '../lib/clock.js';
import { env } from '../config/env.js';
import { notificationService } from '../services/notification.service.js';
import { getVolatilityForecast } from '../services/volatility.service.js';
import { ethText } from '../lib/eth-text.js';

const DAY_MS = 86400_000;
const MAX_BATCH = 200;
let isRunning = false;

export interface LoanRisk {
    loanId: string;
    ltvPercent: number | null;     // what's owed over the stake, both in ETH
    priceMovePercent: number;      // ETH/PHP now vs. at application
    stakeValuePHP: number;
    owedValuePHP: number;
}

/**
 * Loan-to-value and price exposure for one loan. ETH owed over an ETH stake does
 * not move with the price, so LTV only changes with repayments and top-ups; the
 * PHP figures are what a borrower who sold the ETH actually feels.
 */
export function assessLoan(
    loan: { id: string; principalOwed: Prisma.Decimal; interestOwed: Prisma.Decimal; feesOwed: Prisma.Decimal; collateralDeposited: Prisma.Decimal; ethPriceSnapshot: Prisma.Decimal },
    ethPricePHP: number,
): LoanRisk {
    const owed = loan.principalOwed.add(loan.interestOwed).add(loan.feesOwed);
    const stake = loan.collateralDeposited;
    const snapshot = Number(loan.ethPriceSnapshot);
    return {
        loanId: loan.id,
        ltvPercent: stake.gt(0) ? Number(owed.div(stake).mul(100).toFixed(1)) : null,
        priceMovePercent: snapshot > 0 ? Number((((ethPricePHP - snapshot) / snapshot) * 100).toFixed(2)) : 0,
        stakeValuePHP: Math.round(Number(stake) * ethPricePHP),
        owedValuePHP: Math.round(Number(owed) * ethPricePHP),
    };
}

export async function currentEthPrice(): Promise<number> {
    const row = await prisma.systemConfig.findUnique({ where: { key: 'ETH_PHP_RATE' } });
    const price = Number(row?.value ?? env.ETH_PHP_RATE);
    return Number.isFinite(price) && price > 0 ? price : env.ETH_PHP_RATE;
}

/**
 * Advisory margin calls. A loan gets a warning when ETH/PHP has moved
 * MARGIN_CALL_MOVE_PERCENT or more since the application, or when the
 * volatility forecast says HIGH or EXTREME. At most one per loan per day.
 * Nothing here can liquidate; the contract only accepts a missed due date.
 */
export async function runRiskMonitor(): Promise<number> {
    if (isRunning) return 0;
    isRunning = true;

    try {
        await syncClock();
        const current = now();
        const loans = await prisma.loan.findMany({
            where: {
                status: 'ACTIVE',
                collateralDeposited: { gt: 0 },
                OR: [{ marginCallAt: null }, { marginCallAt: { lt: new Date(current.getTime() - DAY_MS) } }],
            },
            take: MAX_BATCH,
        });
        if (loans.length === 0) return 0;

        const price = await currentEthPrice();
        const forecast = await getVolatilityForecast(7).catch(() => null);
        const forecastRisk = forecast?.online ? String(forecast.riskLevel ?? '').toUpperCase() : null;
        const forecastAlarm = forecastRisk === 'HIGH' || forecastRisk === 'EXTREME';

        let warned = 0;
        for (const loan of loans) {
            const owed = loan.principalOwed.add(loan.interestOwed).add(loan.feesOwed);
            if (owed.lte(0)) continue;

            const risk = assessLoan(loan, price);
            const bigMove = Math.abs(risk.priceMovePercent) >= env.MARGIN_CALL_MOVE_PERCENT;
            if (!bigMove && !forecastAlarm) continue;

            const claimed = await prisma.loan.updateMany({
                where: { id: loan.id, marginCallAt: loan.marginCallAt },
                data: { marginCallAt: current },
            });
            if (claimed.count !== 1) continue;

            const direction = risk.priceMovePercent < 0 ? 'fallen' : 'risen';
            const dueText = loan.dueDate
                ? loan.dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                : 'the due date';
            const message = bigMove
                ? `ETH/PHP has ${direction} ${Math.abs(risk.priceMovePercent).toFixed(1)}% since you applied. Your stake is now worth ₱${risk.stakeValuePHP.toLocaleString('en-US')} and the ${ethText(owed)} ETH you owe is worth ₱${risk.owedValuePHP.toLocaleString('en-US')}. Price alone never seizes your stake; repay by ${dueText} to keep it.`
                : `The ETH volatility forecast is ${forecastRisk}. Prices may swing sharply this week. Price alone never seizes your stake; repay ${ethText(owed)} ETH by ${dueText} to keep it.`;

            await notificationService.notify(loan.userId, {
                type: 'COLLATERAL_WARNING',
                title: 'Margin call: ETH price alert',
                message,
                metadata: {
                    ...risk,
                    ethPricePHP: price,
                    forecastRisk,
                    amountDue: owed.toString(),
                    dueDate: loan.dueDate?.toISOString(),
                },
            }, { wait: true });
            warned++;
        }

        if (warned > 0) console.log(`[RiskMonitor] Sent ${warned} margin call(s) at ETH/PHP ${price}`);
        return warned;
    } finally {
        isRunning = false;
    }
}
