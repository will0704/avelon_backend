import { zValidator as honoZodValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import type { ZodType } from 'zod';
import { ValidationError } from '../middleware/error.middleware.js';

/**
 * zValidator that fails with a ValidationError. The default hook answered with the
 * raw ZodError, so apps showed a JSON dump instead of "Purpose is too short".
 */
export function zValidator<T extends ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) {
    return honoZodValidator(target, schema, (result) => {
        if (result.success) return;
        const issue = result.error.issues[0];
        const field = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
        throw new ValidationError(`${field}${issue?.message ?? 'Invalid request'}`, result.error.issues);
    });
}
