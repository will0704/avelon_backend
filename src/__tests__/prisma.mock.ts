import { vi } from 'vitest';

/**
 * Mock Prisma client to avoid database dependency in tests.
 * Individual tests can override specific methods as needed.
 */
const mockPrismaClient = {
    user: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'test-id', email: 'test@test.com' }),
        update: vi.fn().mockResolvedValue({}),
    },
    session: {
        create: vi.fn().mockResolvedValue({}),
        findFirst: vi.fn().mockResolvedValue(null),
        deleteMany: vi.fn().mockResolvedValue({}),
    },
    verificationToken: {
        create: vi.fn().mockResolvedValue({}),
        findFirst: vi.fn().mockResolvedValue(null),
        delete: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({}),
    },
    auditLog: {
        create: vi.fn().mockResolvedValue({}),
    },
    loan: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
    },
    wallet: {
        findMany: vi.fn().mockResolvedValue([]),
    },
};

// Mock the prisma module
vi.mock('../lib/prisma.js', () => ({
    prisma: mockPrismaClient,
}));

export { mockPrismaClient };
