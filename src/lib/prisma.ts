import { PrismaClient } from '../generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env.js';
import crypto from 'crypto';

// =====================================================
// AES-256-GCM Field Encryption (Custom Extension)
// Replaces prisma-field-encryption which is incompatible
// with Prisma 7. Encrypts/decrypts KYC fields marked
// with /// @encrypted in the schema.
// =====================================================

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getCipherKey() {
    const rawKey = env.PRISMA_FIELD_ENCRYPTION_KEY;
    return crypto.createHash('sha256').update(rawKey).digest();
}

function encrypt(text: string | null | undefined): string | null | undefined {
    if (!text) return text;
    try {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, getCipherKey(), iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag().toString('hex');
        return `${iv.toString('hex')}:${authTag}:${encrypted}`;
    } catch {
        return text;
    }
}

function decrypt(text: string | null | undefined): string | null | undefined {
    if (!text || !text.includes(':')) return text;
    try {
        const parts = text.split(':');
        if (parts.length !== 3) return text;
        const decipher = crypto.createDecipheriv(ALGORITHM, getCipherKey(), Buffer.from(parts[0], 'hex'));
        decipher.setAuthTag(Buffer.from(parts[1], 'hex'));
        let decrypted = decipher.update(parts[2], 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch {
        return text;
    }
}

// Encrypted fields on the User model
const ENCRYPTED_FIELDS = ['legalName', 'birthDate', 'address', 'monthlyIncome'] as const;

// Create PostgreSQL adapter for Prisma 7
const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
});

function createPrismaClient() {
    return new PrismaClient({
        adapter,
        log: env.NODE_ENV === 'development'
            ? ['query', 'info', 'warn', 'error']
            : ['error'],
    }).$extends({
        query: {
            user: {
                async create({ args, query }) {
                    for (const field of ENCRYPTED_FIELDS) {
                        if (args.data[field]) {
                            (args.data as any)[field] = encrypt(String(args.data[field]));
                        }
                    }
                    return query(args);
                },
                async update({ args, query }) {
                    for (const field of ENCRYPTED_FIELDS) {
                        const val = (args.data as any)?.[field];
                        if (val && typeof val === 'string') {
                            (args.data as any)[field] = encrypt(val);
                        }
                    }
                    return query(args);
                }
            }
        },
        result: {
            user: {
                legalName: {
                    needs: { legalName: true },
                    compute(user) { return decrypt(user.legalName); }
                },
                address: {
                    needs: { address: true },
                    compute(user) { return decrypt(user.address); }
                },
                birthDate: {
                    needs: { birthDate: true },
                    compute(user) { return decrypt(user.birthDate); }
                },
                monthlyIncome: {
                    needs: { monthlyIncome: true },
                    compute(user) { return decrypt(user.monthlyIncome); }
                }
            }
        }
    });
}

type PrismaClientWithExtensions = ReturnType<typeof createPrismaClient>;

const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClientWithExtensions | undefined;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
}

// Graceful shutdown
process.on('beforeExit', async () => {
    await prisma.$disconnect();
});
