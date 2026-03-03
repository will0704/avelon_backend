// =====================================================
// STRUCTURED SECURITY LOGGER (OWASP A09)
// =====================================================

type SecurityEvent =
    | 'AUTH_FAILURE'
    | 'RATE_LIMIT'
    | 'ACCESS_DENIED'
    | 'ACCOUNT_LOCKOUT'
    | 'SUSPICIOUS_INPUT'
    | 'BRUTE_FORCE'
    | 'INVALID_TOKEN';

interface SecurityLogEntry {
    event: SecurityEvent;
    ip?: string;
    userId?: string;
    userAgent?: string;
    method?: string;
    path?: string;
    details?: Record<string, unknown>;
}

// =====================================================
// LOG SANITIZER — masks personal data before logging
// =====================================================

const SENSITIVE_KEYS = ['email', 'name', 'legalName', 'address', 'phone', 'contactNumber', 'birthDate', 'idNumber', 'monthlyIncome'];

/**
 * Mask a string value for logging.
 * "john@email.com" → "jo***@email.com"
 * "Juan Dela Cruz" → "Ju***uz"
 */
function maskValue(value: string): string {
    if (value.includes('@')) {
        // Email: show first 2 chars + domain
        const [local, domain] = value.split('@');
        return `${local.slice(0, 2)}***@${domain}`;
    }
    if (value.length <= 4) return '***';
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

/**
 * Recursively sanitize an object, masking sensitive fields.
 */
export function sanitizeForLog(obj: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string' && SENSITIVE_KEYS.includes(key)) {
            sanitized[key] = maskValue(value);
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
            sanitized[key] = sanitizeForLog(value as Record<string, unknown>);
        } else {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

// =====================================================
// SECURITY LOGGER
// =====================================================

class SecurityLogger {
    /**
     * Log a structured security event to stdout (JSON format)
     * Designed for log aggregators (CloudWatch, Datadog, ELK, etc.)
     */
    log(entry: SecurityLogEntry): void {
        const logEntry = sanitizeForLog({
            level: 'SECURITY',
            timestamp: new Date().toISOString(),
            ...entry,
            details: entry.details ? sanitizeForLog(entry.details) : undefined,
        });

        // Use console.warn for security events so they stand out
        console.warn(`[SECURITY] ${JSON.stringify(logEntry)}`);
    }

    /**
     * Log an authentication failure
     */
    authFailure(ip: string, email: string, reason: string): void {
        this.log({
            event: 'AUTH_FAILURE',
            ip,
            details: { email, reason },
        });
    }

    /**
     * Log an access denied event
     */
    accessDenied(ip: string, userId: string, path: string, reason: string): void {
        this.log({
            event: 'ACCESS_DENIED',
            ip,
            userId,
            path,
            details: { reason },
        });
    }

    /**
     * Log an invalid token usage
     */
    invalidToken(ip: string, reason: string): void {
        this.log({
            event: 'INVALID_TOKEN',
            ip,
            details: { reason },
        });
    }
}

export const securityLogger = new SecurityLogger();

