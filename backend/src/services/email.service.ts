import nodemailer from 'nodemailer';

// ============================================
// ENV VALIDATION
// ============================================

if (

  !process.env.MAIL_HOST ||
  !process.env.MAIL_PORT ||
  !process.env.MAIL_USER ||
  !process.env.MAIL_PASS ||
  !process.env.FRONTEND_URL

) {

  throw new Error(

    'Missing required mail environment variables'

  );

}

// ============================================
// SMTP TRANSPORTER
// ============================================

export const transporter = nodemailer.createTransport({

  host: process.env.MAIL_HOST,

  port: Number(process.env.MAIL_PORT),

  secure:

    Number(process.env.MAIL_PORT) === 465,

  auth: {

    user: process.env.MAIL_USER,

    pass: process.env.MAIL_PASS,

  },

  connectionTimeout: 20000,

  greetingTimeout: 20000,

  socketTimeout: 30000,

  tls: {

    rejectUnauthorized: false,

  },

});

// ============================================
// VERIFY SMTP CONNECTION
// ============================================

transporter.verify((error) => {

  if (error) {

    console.error(

      'SMTP Connection Error:',

      error

    );

  } else {

    console.log(

      'SMTP Server Ready'

    );

  }

});

// ============================================
// EMAIL TEMPLATE
// ============================================

const generateTemplate = (

  title: string,
  heading: string,
  message: string,
  buttonText: string,
  buttonUrl: string

) => {

  return `

    <div style="
      background:#0f172a;
      padding:40px 20px;
      font-family:Arial,sans-serif;
    ">

      <div style="
        max-width:600px;
        margin:auto;
        background:#ffffff;
        border-radius:24px;
        overflow:hidden;
      ">

        <div style="
          background:
          linear-gradient(
            135deg,
            #06b6d4,
            #8b5cf6,
            #2563eb
          );
          padding:40px;
          text-align:center;
          color:white;
        ">

          <h1 style="
            margin:0;
            font-size:34px;
            font-weight:bold;
          ">
            TEXA
          </h1>

          <p style="
            margin-top:12px;
            opacity:0.9;
            font-size:15px;
          ">
            Premium Realtime Social Platform
          </p>

        </div>

        <div style="
          padding:40px;
        ">

          <h2 style="
            margin-top:0;
            color:#111827;
            font-size:28px;
          ">
            ${heading}
          </h2>

          <p style="
            color:#4b5563;
            line-height:1.8;
            font-size:16px;
          ">
            ${message}
          </p>

          <div style="
            text-align:center;
            margin:40px 0;
          ">

            <a
              href="${buttonUrl}"
              style="
                display:inline-block;
                padding:16px 34px;
                border-radius:16px;
                text-decoration:none;
                font-weight:bold;
                font-size:16px;
                color:white;
                background:
                linear-gradient(
                  135deg,
                  #06b6d4,
                  #8b5cf6
                );
                box-shadow:
                  0 10px 30px
                  rgba(0,0,0,0.15);
              "
            >

              ${buttonText}

            </a>

          </div>

          <p style="
            color:#6b7280;
            font-size:14px;
            line-height:1.7;
          ">
            If you did not request this action,
            you can safely ignore this email.
          </p>

        </div>

        <div style="
          background:#f3f4f6;
          padding:20px;
          text-align:center;
          color:#6b7280;
          font-size:13px;
        ">

          © ${new Date().getFullYear()} TEXA.
          All Rights Reserved.

        </div>

      </div>

    </div>

  `;

};

// ============================================
// SEND VERIFICATION EMAIL
// ============================================

export const sendVerificationEmail = async (

  email: string,
  token: string

) => {

  try {

    const verificationUrl =

      `${process.env.FRONTEND_URL}/verify?token=${token}&email=${encodeURIComponent(email)}`;

    const html = generateTemplate(

      'Verify Email',

      'Verify Your Account',

      'Welcome to TEXA. Click the button below to verify your account and unlock all realtime social features.',

      'Verify Account',

      verificationUrl

    );

    const info =

      await transporter.sendMail({

        from:

          `"TEXA" <${process.env.MAIL_USER}>`,

        to: email,

        subject:

          'Verify Your TEXA Account',

        html,

      });

    console.log(

      'Verification Email Sent:',

      info.messageId

    );

    return info;

  } catch (error) {

    console.error(

      'Verification Email Error:',

      error

    );

    throw new Error(

      'Failed to send verification email'

    );

  }

};

// ============================================
// SEND PASSWORD RESET EMAIL
// ============================================

export const sendPasswordReset = async (

  email: string,
  token: string

) => {

  try {

    const resetUrl =

      `${process.env.FRONTEND_URL}/reset-password?token=${token}&email=${encodeURIComponent(email)}`;

    const html = generateTemplate(

      'Reset Password',

      'Reset Your Password',

      'We received a request to reset your TEXA account password. Click below to continue securely.',

      'Reset Password',

      resetUrl

    );

    const info =

      await transporter.sendMail({

        from:

          `"TEXA" <${process.env.MAIL_USER}>`,

        to: email,

        subject:

          'Reset Your TEXA Password',

        html,

      });

    console.log(

      'Password Reset Email Sent:',

      info.messageId

    );

    return info;

  } catch (error) {

    console.error(

      'Password Reset Email Error:',

      error

    );

    throw new Error(

      'Failed to send password reset email'

    );

  }

};
