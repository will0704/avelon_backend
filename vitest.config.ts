import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/*.test.ts'],
        testTimeout: 10000,
        // In-memory rate limits, so counts left in a real Redis by an earlier run
        // cannot turn expected 400s into 429s
        env: { REDIS_URL: '' },
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, './src'),
        },
    },
});
