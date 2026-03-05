import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

class EmailService {
    private transporter: nodemailer.Transporter | null = null;
    private isConfigured = false;
    private fromAddress: string;

    constructor() {
        this.fromAddress = env.EMAIL_FROM || env.GMAIL_USER;

        if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) {
            this.transporter = nodemailer.createTransport({
                host: 'smtp.gmail.com',
                port: 587,
                secure: false,
                auth: {
                    user: env.GMAIL_USER,
                    pass: env.GMAIL_APP_PASSWORD,
                },
                dnsOptions: { family: 4 },
            } as Record<string, unknown>);
            this.isConfigured = true;
            console.log('✅ Gmail Email Service initialized');
        } else {
            console.warn('⚠️ Gmail credentials not found. Email service is disabled.');
        }
    }

    async sendEmail(to: string, subject: string, html: string): Promise<boolean> {
        if (!this.isConfigured || !this.transporter) {
            console.log(`[STUB] Would have sent email to ${to}: ${subject}`);
            return true;
        }

        try {
            await this.transporter.sendMail({
                from: `"Avelon" <${this.fromAddress}>`,
                to,
                subject,
                html,
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
