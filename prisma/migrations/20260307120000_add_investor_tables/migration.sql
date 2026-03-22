-- Add INVESTOR to UserRole enum
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'INVESTOR';

-- Create DepositStatus enum
CREATE TYPE "DepositStatus" AS ENUM ('PENDING', 'CONFIRMED', 'WITHDRAWN');

-- Create PoolTransactionType enum
CREATE TYPE "PoolTransactionType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'YIELD_EARNED', 'FEE_COLLECTED');

-- CreateTable InvestorDeposit
CREATE TABLE "InvestorDeposit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "txHash" TEXT NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'PENDING',
    "poolSharePercent" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),

    CONSTRAINT "InvestorDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable LiquidityPool
CREATE TABLE "LiquidityPool" (
    "id" TEXT NOT NULL,
    "totalLiquidity" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalBorrowed" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "cumulativeYield" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "utilizationRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "apy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiquidityPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable PoolTransaction
CREATE TABLE "PoolTransaction" (
    "id" TEXT NOT NULL,
    "type" "PoolTransactionType" NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "txHash" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PoolTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvestorDeposit_txHash_key" ON "InvestorDeposit"("txHash");
CREATE INDEX "InvestorDeposit_userId_idx" ON "InvestorDeposit"("userId");
CREATE INDEX "InvestorDeposit_status_idx" ON "InvestorDeposit"("status");
CREATE INDEX "PoolTransaction_userId_idx" ON "PoolTransaction"("userId");
CREATE INDEX "PoolTransaction_type_idx" ON "PoolTransaction"("type");
CREATE INDEX "PoolTransaction_createdAt_idx" ON "PoolTransaction"("createdAt");

-- AddForeignKey
ALTER TABLE "InvestorDeposit" ADD CONSTRAINT "InvestorDeposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolTransaction" ADD CONSTRAINT "PoolTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
