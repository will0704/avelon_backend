import { google } from 'googleapis';
import { env } from '../config/env.js';

class EmailService {
    private gmail: ReturnType<typeof google.gmail> | null = null;
    private isConfigured = false;
    private fromAddress: string;

    constructor() {
        this.fromAddress = env.GMAIL_USER || '';

        if (env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN && env.GMAIL_USER) {
            const oauth2Client = new google.auth.OAuth2(
                env.GMAIL_CLIENT_ID,
                env.GMAIL_CLIENT_SECRET,
            );
            oauth2Client.setCredentials({ refresh_token: env.GMAIL_REFRESH_TOKEN });

            this.gmail = google.gmail({ version: 'v1', auth: oauth2Client });
            this.isConfigured = true;
            console.log('✅ Gmail API Email Service initialized (OAuth2)');
        } else {
            console.warn('⚠️ Gmail OAuth2 credentials not found. Email service is disabled.');
        }
    }

    private buildRawMessage(to: string, subject: string, html: string): string {
        const messageParts = [
            `From: Avelon <${this.fromAddress}>`,
            `To: ${to}`,
            `Subject: ${subject}`,
            'MIME-Version: 1.0',
            'Content-Type: text/html; charset=utf-8',
            '',
            html,
        ];
        const message = messageParts.join('\r\n');
        return Buffer.from(message).toString('base64url');
    }

    async sendEmail(to: string, subject: string, html: string): Promise<boolean> {
        if (!this.isConfigured || !this.gmail) {
            console.log(`[STUB] Would have sent email to ${to}: ${subject}`);
            return true;
        }

        try {
            await this.gmail.users.messages.send({
                userId: 'me',
                requestBody: {
                    raw: this.buildRawMessage(to, subject, html),
                },
            });
            return true;
        } catch (error) {
            console.error('Email service error:', error);
            return false;
        }
    }

    async sendVerificationEmail(to: string, otp: string): Promise<boolean> {
        const subject = 'Verify your Avelon Account';
        const html = `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <h1 style="color: #000;">Welcome to Avelon!</h1>
                <p>Thank you for registering. Please enter the following 6-digit code in the app to verify your email address:</p>
                <div style="background-color: #f4f4f4; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
                    <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #000;">${otp}</span>
                </div>
                <p>This code will expire in 1 hour.</p>
                <p>If you did not request this verification, please ignore this email.</p>
            </div>
        `;
        return this.sendEmail(to, subject, html);
    }

    async sendPasswordResetEmail(to: string, otp: string): Promise<boolean> {
        const subject = 'Reset your Avelon Password';
        const html = `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <h1 style="color: #000;">Password Reset Request</h1>
                <p>We received a request to reset your password. Please enter the following 6-digit code in the app to proceed:</p>
                <div style="background-color: #f4f4f4; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
                    <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #000;">${otp}</span>
                </div>
                <p>This code will expire in 1 hour.</p>
                <p>If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>
            </div>
        `;
        return this.sendEmail(to, subject, html);
    }
}

export const emailService = new EmailService();
