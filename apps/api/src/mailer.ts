import nodemailer, { type Transporter } from 'nodemailer';
import { config } from './config.js';
import { setting } from './settings.js';

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
 * SMTP works with any provider, so none is baked in. The connection and the
 * send-from address come from the API keys screen, or else from SMTP_URL and
 * MAIL_FROM in the environment, and are read on every send, so a change takes
 * effect without a restart. Without an SMTP connection the message is written
 * to the log instead, which is enough for development: the link is in the text.
 */
export function createMailer(): Mailer {
  let transport: Transporter | null = null;
  let transportFor = '';
  return {
    get enabled() {
      return setting('SMTP_URL') !== '';
    },
    async send(mail) {
      const smtpUrl = setting('SMTP_URL');
      if (!smtpUrl) {
        if (config.isTest) return;
        console.log(`[email not sent: no SMTP connection is set]\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n`);
        return;
      }
      if (!transport || transportFor !== smtpUrl) {
        transport?.close();
        transport = nodemailer.createTransport(smtpUrl);
        transportFor = smtpUrl;
      }
      await transport.sendMail({
        from: { name: mail.fromName, address: setting('MAIL_FROM') || config.defaultMailFrom },
        to: mail.to,
        subject: mail.subject.replace(/[\r\n]+/g, ' '),
        text: mail.text,
        html: mail.html,
      });
    },
  };
}
