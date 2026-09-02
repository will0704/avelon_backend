-- Loan applications now wait for an admin decision. The on-chain loan is created
-- on approval, so a rejected application never reaches the chain.

ALTER TYPE "LoanStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL';
ALTER TYPE "LoanStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

ALTER TABLE "Loan"
    ADD COLUMN "approvedAt" TIMESTAMP(3),
    ADD COLUMN "approvedBy" TEXT,
    ADD COLUMN "rejectedAt" TIMESTAMP(3),
    ADD COLUMN "rejectedBy" TEXT,
    ADD COLUMN "rejectionReason" TEXT;

ALTER TABLE "Loan" ALTER COLUMN "status" SET DEFAULT 'PENDING_APPROVAL';
