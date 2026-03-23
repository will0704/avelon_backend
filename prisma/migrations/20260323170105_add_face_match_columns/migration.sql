-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "faceMatchPassed" BOOLEAN,
ADD COLUMN     "faceMatchScore" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Wallet" ALTER COLUMN "chainId" SET DEFAULT 11155111;
