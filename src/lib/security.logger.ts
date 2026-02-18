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

class SecurityLogger {
    /**
     * Log a structured security event to stdout (JSON format)
     * Designed for log aggregators (CloudWatch, Datadog, ELK, etc.)
     */
    log(entry: SecurityLogEntry): void {
        const logEntry = {
            level: 'SECURITY',
            timestamp: new Date().toISOString(),
            ...entry,
        };

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
