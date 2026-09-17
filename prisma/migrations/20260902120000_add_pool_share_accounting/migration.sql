-- Investor pool moves from off-chain bookkeeping to AvelonLiquidityPool share
-- accounting. The chain stays authoritative for what a position is worth; these
-- columns record which on-chain event produced each ledger row.

ALTER TYPE "PoolTransactionType" ADD VALUE 'YIELD_CLAIMED';

ALTER TABLE "InvestorDeposit"
    ADD COLUMN "sharesMinted" DECIMAL(65,30),
    ADD COLUMN "blockNumber" INTEGER;

ALTER TABLE "PoolTransaction"
    ADD COLUMN "sharesDelta" DECIMAL(65,30);

ALTER TABLE "LiquidityPool"
    ADD COLUMN "poolAddress" TEXT;
