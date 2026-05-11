import nodemailer from 'nodemailer';
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST, port: Number(process.env.MAIL_PORT),
  secure: false, auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
});

export const sendVerificationEmail = async (email: string, token: string) => {
  const url = `${process.env.FRONTEND_URL}/verify?token=${token}&email=${encodeURIComponent(email)}`;
  await transporter.sendMail({ from: 'Texa <noreply@texa.app>', to: email, subject: 'Verify Your Texa Account', html: `<p>Click to verify:</p><a href="${url}">${url}</a>` });
};

export const sendPasswordReset = async (email: string, token: string) => {
  const url = `${process.env.FRONTEND_URL}/reset?token=${token}&email=${encodeURIComponent(email)}`;
  await transporter.sendMail({ from: 'Texa <noreply@texa.app>', to: email, subject: 'Reset Your Texa Password', html: `<p>Reset your password:</p><a href="${url}">${url}</a>` });
};
