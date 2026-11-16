import nodemailer from 'nodemailer';
import { config } from './config.js';

export interface Mail {
  to: string;
  /** Display name of the sender: the agency's, or the platform's on its own host. */
  fromName: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  /** False when no SMTP server is configured and messages are only logged. */
  enabled: boolean;
  send(mail: Mail): Promise<void>;
}

/**
 * SMTP works with any provider, so none is baked in. Without SMTP_URL the
 * message is written to the log instead, which is enough for development:
 * the invite or reset link is in the text.
 */
export function createMailer(): Mailer {
  if (!config.smtpUrl) {
    return {
      enabled: false,
      async send(mail) {
        if (config.isTest) return;
        console.log(`[email not sent: SMTP_URL is not set]\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n`);
      },
    };
  }
  const transport = nodemailer.createTransport(config.smtpUrl);
  return {
    enabled: true,
    async send(mail) {
      await transport.sendMail({
        from: { name: mail.fromName, address: config.mailFrom },
        to: mail.to,
        subject: mail.subject.replace(/[\r\n]+/g, ' '),
        text: mail.text,
        html: mail.html,
      });
    },
  };
}
