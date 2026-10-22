import { Prisma } from '../generated/prisma/client.js';

/**
 * An ETH amount for people to read: six places, rounded up so an amount owed is
 * never understated. Metadata keeps the exact figure for the apps to pay with.
 */
export function ethText(value: Prisma.Decimal | string | number): string {
    return new Prisma.Decimal(value).toDecimalPlaces(6, Prisma.Decimal.ROUND_UP).toString();
}
