import { config } from 'dotenv';
import { z } from 'zod';

// Load environment variables
config();

// Environment schema validation
const envSchema = z.object({
    // Server
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(3001),

    // Database
    DATABASE_URL: z.string().url(),

    // Redis
    REDIS_URL: z.string().url().optional(),

    // JWT
    JWT_SECRET: z.string().min(32),
    JWT_ACCESS_EXPIRY: z.string().default('15m'),
    JWT_REFRESH_EXPIRY: z.string().default('7d'),

    // Email
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().email().default('noreply@avelon.finance'),

    // Blockchain
    GANACHE_URL: z.string().url().default('http://127.0.0.1:8545'),
    DEPLOYER_PRIVATE_KEY: z.string().optional(),
    TREASURY_ADDRESS: z.string().optional(),
    AVELON_CORE_ADDRESS: z.string().optional(),
    LOAN_MANAGER_ADDRESS: z.string().optional(),
    PRICE_ORACLE_ADDRESS: z.string().optional(),

    // AI Service
    AI_SERVICE_URL: z.string().url().default('http://localhost:8000'),

    // Firebase
    FIREBASE_PROJECT_ID: z.string().optional(),
    FIREBASE_PRIVATE_KEY: z.string().optional(),
    FIREBASE_CLIENT_EMAIL: z.string().optional(),

    // Storage
    STORAGE_PATH: z.string().default('./uploads'),
    ENCRYPTION_KEY: z.string().min(32).optional(),

    // Database Encryption
    PRISMA_FIELD_ENCRYPTION_KEY: z.string().min(32),

    // App Config
    ETH_PHP_RATE: z.coerce.number().default(150000),
    MIN_COLLATERAL_RATIO: z.coerce.number().default(120),
    WARNING_COLLATERAL_RATIO: z.coerce.number().default(130),
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

// Export types
export type Env = z.infer<typeof envSchema>;
