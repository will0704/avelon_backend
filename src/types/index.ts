/**
 * Local copy of shared types from @/types/index.js.
 * Inlined because the file:../avelon_types dependency is unavailable
 * on Render's build environment.
 */

// ── User ────────────────────────────────────────────

export enum UserRole {
    ADMIN = 'ADMIN',
    BORROWER = 'BORROWER',
    INVESTOR = 'INVESTOR',
}

export enum UserStatus {
    REGISTERED = 'REGISTERED',
    VERIFIED = 'VERIFIED',
    PENDING_KYC = 'PENDING_KYC',
    APPROVED = 'APPROVED',
    CONNECTED = 'CONNECTED',
    REJECTED = 'REJECTED',
    SUSPENDED = 'SUSPENDED',
}

// ── Auth ────────────────────────────────────────────

export interface LoginCredentials {
    email: string;
    password: string;
}

export interface RegisterData {
    email: string;
    password: string;
    name?: string;
    role?: UserRole.BORROWER | UserRole.INVESTOR;
}

export interface TokenPayload {
    userId: string;
    email: string;
    role: string;
    type: 'access';
    jti: string;
    iat: number;
    exp: number;
}

export interface AuthTokens {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
}

// ── Loan ────────────────────────────────────────────

export enum LoanStatus {
    PENDING_APPROVAL = 'PENDING_APPROVAL',
    REJECTED = 'REJECTED',
    PENDING_COLLATERAL = 'PENDING_COLLATERAL',
    COLLATERAL_DEPOSITED = 'COLLATERAL_DEPOSITED',
    ACTIVE = 'ACTIVE',
    REPAID = 'REPAID',
    LIQUIDATED = 'LIQUIDATED',
    CANCELLED = 'CANCELLED',
    EXPIRED = 'EXPIRED',
}

export enum LoanTransactionType {
    COLLATERAL_DEPOSIT = 'COLLATERAL_DEPOSIT',
    LOAN_DISBURSEMENT = 'LOAN_DISBURSEMENT',
    REPAYMENT = 'REPAYMENT',
    COLLATERAL_TOPUP = 'COLLATERAL_TOPUP',
    COLLATERAL_RETURN = 'COLLATERAL_RETURN',
    LIQUIDATION = 'LIQUIDATION',
    FEE_PAYMENT = 'FEE_PAYMENT',
}

// ── Investor ────────────────────────────────────────

export enum DepositStatus {
    PENDING = 'PENDING',
    CONFIRMED = 'CONFIRMED',
    WITHDRAWN = 'WITHDRAWN',
}

// ── Error ───────────────────────────────────────────

export enum ErrorCode {
    // Authentication
    UNAUTHORIZED = 'UNAUTHORIZED',
    INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
    TOKEN_EXPIRED = 'TOKEN_EXPIRED',
    SESSION_EXPIRED = 'SESSION_EXPIRED',
    EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED',
    ACCOUNT_SUSPENDED = 'ACCOUNT_SUSPENDED',

    // Authorization
    FORBIDDEN = 'FORBIDDEN',
    INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',
    ADMIN_ONLY = 'ADMIN_ONLY',
    KYC_REQUIRED = 'KYC_REQUIRED',

    // Validation
    VALIDATION_ERROR = 'VALIDATION_ERROR',
    INVALID_INPUT = 'INVALID_INPUT',
    MISSING_REQUIRED_FIELD = 'MISSING_REQUIRED_FIELD',
    INVALID_FORMAT = 'INVALID_FORMAT',

    // Resource
    NOT_FOUND = 'NOT_FOUND',
    USER_NOT_FOUND = 'USER_NOT_FOUND',
    LOAN_NOT_FOUND = 'LOAN_NOT_FOUND',
    DOCUMENT_NOT_FOUND = 'DOCUMENT_NOT_FOUND',
    WALLET_NOT_FOUND = 'WALLET_NOT_FOUND',
    PLAN_NOT_FOUND = 'PLAN_NOT_FOUND',
    ALREADY_EXISTS = 'ALREADY_EXISTS',
    EMAIL_ALREADY_EXISTS = 'EMAIL_ALREADY_EXISTS',
    WALLET_ALREADY_CONNECTED = 'WALLET_ALREADY_CONNECTED',

    // Business Logic
    INELIGIBLE_FOR_LOAN = 'INELIGIBLE_FOR_LOAN',
    INSUFFICIENT_CREDIT_SCORE = 'INSUFFICIENT_CREDIT_SCORE',
    LOAN_AMOUNT_EXCEEDS_LIMIT = 'LOAN_AMOUNT_EXCEEDS_LIMIT',
    LOAN_NOT_ACTIVE = 'LOAN_NOT_ACTIVE',
    LOAN_ALREADY_REPAID = 'LOAN_ALREADY_REPAID',
    INSUFFICIENT_COLLATERAL = 'INSUFFICIENT_COLLATERAL',
    EXTENSION_NOT_ALLOWED = 'EXTENSION_NOT_ALLOWED',
    ALREADY_EXTENDED = 'ALREADY_EXTENDED',
    KYC_ALREADY_APPROVED = 'KYC_ALREADY_APPROVED',
    DOCUMENTS_INCOMPLETE = 'DOCUMENTS_INCOMPLETE',

    // Blockchain
    BLOCKCHAIN_ERROR = 'BLOCKCHAIN_ERROR',
    TRANSACTION_FAILED = 'TRANSACTION_FAILED',
    INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
    INVALID_SIGNATURE = 'INVALID_SIGNATURE',
    CONTRACT_ERROR = 'CONTRACT_ERROR',

    // External Services
    AI_SERVICE_ERROR = 'AI_SERVICE_ERROR',
    EMAIL_SERVICE_ERROR = 'EMAIL_SERVICE_ERROR',
    PUSH_NOTIFICATION_ERROR = 'PUSH_NOTIFICATION_ERROR',

    // Rate Limiting
    RATE_LIMITED = 'RATE_LIMITED',
    TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS',
    LOGIN_ATTEMPTS_EXCEEDED = 'LOGIN_ATTEMPTS_EXCEEDED',

    // Server
    INTERNAL_ERROR = 'INTERNAL_ERROR',
    SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
    DATABASE_ERROR = 'DATABASE_ERROR',
}
