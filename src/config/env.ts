import { config } from 'dotenv';
import { z } from 'zod';

// Load environment variables
config();

// Environment schema validation
const envSchema = z.object({
    // Server
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(3001),
    ENABLE_BACKGROUND_JOBS: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
    // Returns the email/reset OTP in the API response so a local demo can verify an
    // account with no mailbox. Ignored outside development — see exposeDemoOtp.
    DEMO_EXPOSE_OTP: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
    CORS_ALLOWED_ORIGINS: z.string().default([
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:3002',
        'http://localhost:19006',
        'https://avelon-web.vercel.app',
    ].join(',')),

    // How many proxies sit in front of this server. Each one appends an entry to
    // X-Forwarded-For, so this says how many trailing entries are trustworthy.
    // 0 (default) means the socket address is used and the header is ignored —
    // anything else lets a client forge its own rate-limit identity.
    // Render puts exactly one load balancer in front, so set this to 1 there.
    TRUSTED_PROXY_COUNT: z.coerce.number().int().min(0).default(0),

    // Database
    DATABASE_URL: z.string().url(),

    // Redis
    REDIS_URL: z.string().url().optional(),

    // JWT
    JWT_SECRET: z.string().min(32),
    JWT_ACCESS_EXPIRY: z.string().default('15m'),
    JWT_REFRESH_EXPIRY: z.string().default('7d'),

    // Email (Gmail API OAuth2)
    GMAIL_CLIENT_ID: z.string().optional(),
    GMAIL_CLIENT_SECRET: z.string().optional(),
    GMAIL_REFRESH_TOKEN: z.string().optional(),
    GMAIL_USER: z.string().email().optional(),

    // Blockchain — chain-neutral names. The deployment target is Base Sepolia
    // (84532); the SEPOLIA_* names below are the old ones and still work as a
    // fallback so Render and the Windows checkouts keep booting.
    CHAIN_ID: z.coerce.number().optional(),
    CHAIN_RPC_URL: z.string().url().optional(),
    CHAIN_PRIVATE_KEY: z.string().optional(),
    CHAIN_MIN_CONFIRMATIONS: z.coerce.number().int().min(1).max(64).default(1),

    // Blockchain (Sepolia — superseded, kept as a fallback)
    SEPOLIA_RPC_URL: z.string().url().optional(),
    SEPOLIA_PRIVATE_KEY: z.string().optional(),
    TREASURY_ADDRESS: z.string().optional(),
    AVELON_LENDING_ADDRESS: z.string().optional(),
    COLLATERAL_MANAGER_ADDRESS: z.string().optional(),
    REPAYMENT_SCHEDULE_ADDRESS: z.string().optional(),

    // Blockchain (Legacy local - optional fallback)
    GANACHE_URL: z.string().url().optional(),
    DEPLOYER_PRIVATE_KEY: z.string().optional(),

    // AI Service
    AI_SERVICE_URL: z.string().url().default('http://localhost:8000'),
    AI_API_KEY: z.string().default('dev-api-key-change-in-production'),

    // Firebase (FCM Push Notifications)
    FIREBASE_PROJECT_ID: z.string().optional(),
    FIREBASE_PRIVATE_KEY: z.string().optional(),
    FIREBASE_CLIENT_EMAIL: z.string().email().optional(),

    // Storage
    STORAGE_PATH: z.string().default('./uploads'),
    ENCRYPTION_KEY: z.string().min(32).optional(),
    KYC_STORAGE_MODE: z.enum(['local', 'object']).default('local'),

    // Database Encryption
    PRISMA_FIELD_ENCRYPTION_KEY: z.string().min(32),

    // App Config
    ETH_PHP_RATE: z.coerce.number().default(150000),
    // Borrower's own stake as a percent of principal, not full security for the
    // debt. 35 is the panel's floor (revision 5).
    MIN_COLLATERAL_RATIO: z.coerce.number().default(35),
    WARNING_COLLATERAL_RATIO: z.coerce.number().default(40),
    GRACE_PERIOD_HOURS: z.coerce.number().default(24),
    LIQUIDATION_PENALTY_PERCENT: z.coerce.number().default(5),
});

// Parse and validate environment
const parseEnv = () => {
    const result = envSchema.safeParse(process.env);

    if (!result.success) {
        console.error('❌ Invalid environment variables:');
        console.error(result.error.format());
        throw new Error('Invalid environment configuration');
    }

    return result.data;
};

export const env = parseEnv();

/**
 * Whether verification codes may be returned to the caller.
 *
 * Handing an OTP back over the API defeats the point of sending it out of band, so
 * this is refused outside development no matter what the variable says. It exists
 * because the capstone demo runs with no mailbox attached.
 */
export const exposeDemoOtp = env.DEMO_EXPOSE_OTP && env.NODE_ENV === 'development';

if (env.DEMO_EXPOSE_OTP && !exposeDemoOtp) {
    console.warn('[env] DEMO_EXPOSE_OTP is set but ignored — it only applies in development.');
}
if (exposeDemoOtp) {
    console.warn('[env] DEMO_EXPOSE_OTP is on: verification codes are returned in API responses. Development only.');
}

export const corsAllowedOrigins = env.CORS_ALLOWED_ORIGINS
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

// Block explorers, by chain id
const EXPLORERS: Record<number, string> = {
    84532: 'https://sepolia.basescan.org',
    11155111: 'https://sepolia.etherscan.io',
};

const BASE_SEPOLIA = 84532;
const ETH_SEPOLIA = 11155111;

// Falling back to SEPOLIA_RPC_URL has to fall back to its chain id too, or we
// declare Base Sepolia while pointing at Ethereum Sepolia and every call fails
// on a network mismatch.
const usingLegacySepolia = !env.CHAIN_RPC_URL && !!env.SEPOLIA_RPC_URL;

/**
 * Chain settings resolved once, newest name first. Everything that talks to the
 * chain should read this rather than the raw SEPOLIA_* vars.
 */
const chainId = env.CHAIN_ID ?? (usingLegacySepolia ? ETH_SEPOLIA : BASE_SEPOLIA);

export const chain = {
    id: chainId,
    rpcUrl: env.CHAIN_RPC_URL ?? env.SEPOLIA_RPC_URL ?? env.GANACHE_URL ?? 'http://127.0.0.1:8545',
    privateKey: env.CHAIN_PRIVATE_KEY ?? env.SEPOLIA_PRIVATE_KEY ?? env.DEPLOYER_PRIVATE_KEY,
    explorerUrl: EXPLORERS[chainId] ?? null,
    minConfirmations: env.CHAIN_MIN_CONFIRMATIONS,
} as const;

// Export types
export type Env = z.infer<typeof envSchema>;
