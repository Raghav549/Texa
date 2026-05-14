import nodemailer, { type SendMailOptions, type Transporter } from 'nodemailer';
import crypto from 'crypto';

type MailTemplateInput = {
  title: string;
  heading: string;
  message: string;
  buttonText?: string;
  buttonUrl?: string;
  footerText?: string;
  previewText?: string;
  secondaryMessage?: string;
};

type SendAppMailInput = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  attachments?: SendMailOptions['attachments'];
  headers?: Record<string, string>;
};

type MailTokenInput = {
  email: string;
  token: string;
  name?: string | null;
};

type SecurityMailInput = {
  email: string;
  title: string;
  message: string;
  actionText?: string;
  actionUrl?: string;
};

const requiredEnv = ['MAIL_HOST', 'MAIL_PORT', 'MAIL_USER', 'MAIL_PASS', 'FRONTEND_URL'] as const;

for (const key of requiredEnv) {
  if (!process.env[key] || String(process.env[key]).trim() === '') {
    throw new Error(`${key} is missing`);
  }
}

const MAIL_HOST = String(process.env.MAIL_HOST).trim();
const MAIL_PORT = Number(process.env.MAIL_PORT);
const MAIL_USER = String(process.env.MAIL_USER).trim();
const MAIL_PASS = String(process.env.MAIL_PASS);
const FRONTEND_URL = String(process.env.FRONTEND_URL).replace(/\/+$/, '');
const MAIL_FROM_NAME = String(process.env.MAIL_FROM_NAME || 'TEXA').trim();
const MAIL_BRAND_NAME = String(process.env.MAIL_BRAND_NAME || 'TEXA').trim();
const MAIL_REPLY_TO = process.env.MAIL_REPLY_TO?.trim();
const MAIL_UNSUBSCRIBE_URL = process.env.MAIL_UNSUBSCRIBE_URL?.trim();
const MAIL_SECURE = process.env.MAIL_SECURE ? process.env.MAIL_SECURE === 'true' : MAIL_PORT === 465;
const MAIL_VERIFY_ON_BOOT = process.env.MAIL_VERIFY_ON_BOOT !== 'false';
const MAIL_MAX_RETRIES = Math.max(1, Math.min(Number(process.env.MAIL_MAX_RETRIES || 2), 5));

if (!Number.isFinite(MAIL_PORT) || MAIL_PORT <= 0) {
  throw new Error('MAIL_PORT is invalid');
}

export const transporter: Transporter = nodemailer.createTransport({
  host: MAIL_HOST,
  port: MAIL_PORT,
  secure: MAIL_SECURE,
  auth: {
    user: MAIL_USER,
    pass: MAIL_PASS
  },
  pool: process.env.MAIL_POOL !== 'false',
  maxConnections: Number(process.env.MAIL_MAX_CONNECTIONS || 5),
  maxMessages: Number(process.env.MAIL_MAX_MESSAGES || 100),
  connectionTimeout: Number(process.env.MAIL_CONNECTION_TIMEOUT || 20_000),
  greetingTimeout: Number(process.env.MAIL_GREETING_TIMEOUT || 20_000),
  socketTimeout: Number(process.env.MAIL_SOCKET_TIMEOUT || 30_000),
  tls: {
    rejectUnauthorized: process.env.MAIL_TLS_REJECT_UNAUTHORIZED === 'true'
  }
});

if (MAIL_VERIFY_ON_BOOT) {
  transporter.verify().then(() => {
    console.log('SMTP Server Ready');
  }).catch(error => {
    console.error('SMTP Connection Error:', error?.message || error);
  });
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function normalizeRecipients(value: string | string[]) {
  const recipients = Array.isArray(value) ? value : [value];
  const clean = recipients.map(item => item.trim().toLowerCase()).filter(Boolean);
  if (!clean.length) throw new Error('Email recipient is missing');
  for (const email of clean) {
    if (!isValidEmail(email)) throw new Error(`Invalid email recipient: ${email}`);
  }
  return clean;
}

function buildAppUrl(path: string, params: Record<string, string>) {
  const url = new URL(path.replace(/^\/?/, '/'), FRONTEND_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function stripHtml(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildTrackingHeaders(subject: string) {
  const id = crypto.createHash('sha256').update(`${subject}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 24);
  const headers: Record<string, string> = {
    'X-TEXA-Mail-ID': id,
    'X-Entity-Ref-ID': id
  };

  if (MAIL_UNSUBSCRIBE_URL) {
    headers['List-Unsubscribe'] = `<${MAIL_UNSUBSCRIBE_URL}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  return headers;
}

export function generateTemplate(input: MailTemplateInput) {
  const title = escapeHtml(input.title);
  const heading = escapeHtml(input.heading);
  const message = escapeHtml(input.message);
  const buttonText = escapeHtml(input.buttonText || '');
  const buttonUrl = input.buttonUrl || '';
  const previewText = escapeHtml(input.previewText || input.message);
  const secondaryMessage = input.secondaryMessage ? escapeHtml(input.secondaryMessage) : '';
  const footerText = escapeHtml(input.footerText || `© ${new Date().getFullYear()} ${MAIL_BRAND_NAME}. All Rights Reserved.`);
  const safeButtonUrl = buttonUrl ? escapeHtml(buttonUrl) : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:Arial,Helvetica,sans-serif;color:#111827;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${previewText}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0f172a;padding:40px 16px;">
<tr>
<td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:28px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,0.28);">
<tr>
<td style="background:linear-gradient(135deg,#06b6d4,#8b5cf6,#2563eb);padding:42px 28px;text-align:center;color:#ffffff;">
<div style="font-size:38px;font-weight:900;letter-spacing:1px;line-height:1;">${escapeHtml(MAIL_BRAND_NAME)}</div>
<div style="margin-top:12px;font-size:15px;line-height:1.6;opacity:.92;">Premium Realtime Social Platform</div>
</td>
</tr>
<tr>
<td style="padding:42px 34px;">
<h1 style="margin:0 0 18px;color:#111827;font-size:30px;line-height:1.25;font-weight:900;">${heading}</h1>
<p style="margin:0;color:#4b5563;font-size:16px;line-height:1.85;">${message}</p>
${secondaryMessage ? `<p style="margin:18px 0 0;color:#4b5563;font-size:15px;line-height:1.75;">${secondaryMessage}</p>` : ''}
${safeButtonUrl && buttonText ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:38px 0 34px;"><tr><td align="center"><a href="${safeButtonUrl}" style="display:inline-block;padding:16px 34px;border-radius:16px;text-decoration:none;font-weight:900;font-size:16px;color:#ffffff;background:linear-gradient(135deg,#06b6d4,#8b5cf6);box-shadow:0 14px 34px rgba(37,99,235,.24);">${buttonText}</a></td></tr></table>` : ''}
${safeButtonUrl ? `<p style="margin:0;color:#6b7280;font-size:13px;line-height:1.7;word-break:break-word;">If the button does not work, copy and paste this link into your browser:<br>${safeButtonUrl}</p>` : ''}
<p style="margin:28px 0 0;color:#6b7280;font-size:14px;line-height:1.7;">If you did not request this action, you can safely ignore this email.</p>
</td>
</tr>
<tr>
<td style="background:#f3f4f6;padding:22px;text-align:center;color:#6b7280;font-size:13px;line-height:1.7;">
${footerText}
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
}

export async function sendAppMail(input: SendAppMailInput) {
  const recipients = normalizeRecipients(input.to);
  const headers = {
    ...buildTrackingHeaders(input.subject),
    ...(input.headers || {})
  };

  const payload: SendMailOptions = {
    from: `"${MAIL_FROM_NAME}" <${MAIL_USER}>`,
    to: recipients,
    subject: input.subject,
    html: input.html,
    text: input.text || stripHtml(input.html),
    replyTo: input.replyTo || MAIL_REPLY_TO,
    attachments: input.attachments,
    headers
  };

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAIL_MAX_RETRIES; attempt++) {
    try {
      const info = await transporter.sendMail(payload);
      console.log('Email Sent:', info.messageId, recipients.join(','));
      return info;
    } catch (error) {
      lastError = error;
      if (attempt < MAIL_MAX_RETRIES) await sleep(500 * attempt);
    }
  }

  console.error('Email Send Error:', (lastError as any)?.message || lastError);
  throw new Error('Failed to send email');
}

export async function sendVerificationEmail(email: string, token: string) {
  const verificationUrl = buildAppUrl('/verify', {
    token,
    email: email.trim().toLowerCase()
  });

  const html = generateTemplate({
    title: 'Verify Email',
    heading: 'Verify Your Account',
    message: 'Welcome to TEXA. Click the button below to verify your account and unlock all realtime social features.',
    buttonText: 'Verify Account',
    buttonUrl: verificationUrl,
    previewText: 'Verify your TEXA account securely.'
  });

  return sendAppMail({
    to: email,
    subject: 'Verify Your TEXA Account',
    html
  });
}

export async function sendPasswordReset(email: string, token: string) {
  const resetUrl = buildAppUrl('/reset-password', {
    token,
    email: email.trim().toLowerCase()
  });

  const html = generateTemplate({
    title: 'Reset Password',
    heading: 'Reset Your Password',
    message: 'We received a request to reset your TEXA account password. Click below to continue securely.',
    buttonText: 'Reset Password',
    buttonUrl: resetUrl,
    previewText: 'Reset your TEXA password securely.'
  });

  return sendAppMail({
    to: email,
    subject: 'Reset Your TEXA Password',
    html
  });
}

export async function sendWelcomeEmail(input: { email: string; name?: string | null }) {
  const dashboardUrl = buildAppUrl('/home', {});
  const name = input.name?.trim();

  const html = generateTemplate({
    title: 'Welcome to TEXA',
    heading: name ? `Welcome, ${name}` : 'Welcome to TEXA',
    message: 'Your TEXA account is ready. Explore realtime rooms, reels, stories, creators, shops, rewards, and premium social features.',
    buttonText: 'Open TEXA',
    buttonUrl: dashboardUrl,
    previewText: 'Your TEXA account is ready.'
  });

  return sendAppMail({
    to: input.email,
    subject: 'Welcome to TEXA',
    html
  });
}

export async function sendSecurityAlert(input: SecurityMailInput) {
  const html = generateTemplate({
    title: input.title,
    heading: input.title,
    message: input.message,
    buttonText: input.actionText,
    buttonUrl: input.actionUrl,
    previewText: input.message
  });

  return sendAppMail({
    to: input.email,
    subject: input.title,
    html
  });
}

export async function sendEmailChangeVerification(input: MailTokenInput) {
  const url = buildAppUrl('/verify-email-change', {
    token: input.token,
    email: input.email.trim().toLowerCase()
  });

  const html = generateTemplate({
    title: 'Confirm Email Change',
    heading: 'Confirm Your New Email',
    message: 'Click below to confirm this email address for your TEXA account.',
    buttonText: 'Confirm Email',
    buttonUrl: url,
    previewText: 'Confirm your new TEXA email address.'
  });

  return sendAppMail({
    to: input.email,
    subject: 'Confirm Your TEXA Email',
    html
  });
}

export async function sendAdminInviteEmail(input: MailTokenInput & { role?: string }) {
  const url = buildAppUrl('/admin/invite', {
    token: input.token,
    email: input.email.trim().toLowerCase()
  });

  const html = generateTemplate({
    title: 'TEXA Admin Invitation',
    heading: 'Admin Access Invitation',
    message: `You have been invited to join TEXA admin panel${input.role ? ` as ${input.role}` : ''}. Click below to accept the invitation and set your secure password.`,
    buttonText: 'Accept Invitation',
    buttonUrl: url,
    previewText: 'You have been invited to TEXA admin panel.'
  });

  return sendAppMail({
    to: input.email,
    subject: 'TEXA Admin Invitation',
    html
  });
}

export async function sendOtpEmail(input: { email: string; otp: string; purpose?: string; expiresInMinutes?: number }) {
  const purpose = input.purpose || 'verification';
  const expiresInMinutes = input.expiresInMinutes || 10;

  const html = generateTemplate({
    title: 'Your TEXA OTP',
    heading: 'Your Verification Code',
    message: `Your ${purpose} code is ${input.otp}. This code will expire in ${expiresInMinutes} minutes.`,
    secondaryMessage: 'Never share this code with anyone. TEXA will never ask for your password or OTP outside the app.',
    previewText: `Your TEXA OTP is ${input.otp}.`
  });

  return sendAppMail({
    to: input.email,
    subject: 'Your TEXA Verification Code',
    html
  });
}

export async function sendMagicLoginEmail(input: MailTokenInput) {
  const url = buildAppUrl('/magic-login', {
    token: input.token,
    email: input.email.trim().toLowerCase()
  });

  const html = generateTemplate({
    title: 'Login to TEXA',
    heading: 'Secure Login Link',
    message: 'Click below to securely login to your TEXA account. This link will expire soon.',
    buttonText: 'Login Securely',
    buttonUrl: url,
    previewText: 'Use your secure TEXA login link.'
  });

  return sendAppMail({
    to: input.email,
    subject: 'Login to TEXA',
    html
  });
}

export async function closeMailTransporter() {
  transporter.close();
  return true;
}
