import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ownerPool } from './db.js';

/**
 * Platform settings the super admin can enter on the "API keys" screen.
 *
 * A saved value wins over the server environment variable of the same name;
 * with nothing saved, the environment variable is used, so existing setups
 * keep working. Each process keeps the settings in memory and re-reads them
 * every 15 seconds, so a saved key reaches the API and every worker without a
 * restart.
 */

export type SettingGroup = 'chatgpt' | 'perplexity' | 'gemini' | 'writer' | 'email' | 'billing';

export interface SettingSpec {
  key: string;
  group: SettingGroup;
  label: string;
  secret: boolean;
  help: string;
  placeholder?: string;
  /** Fixed choices, shown as a list instead of a text box. */
  choices?: { value: string; label: string }[];
  validate: (value: string) => string | null;
}

const apiKey = (value: string) => (/^\S{8,500}$/.test(value) ? null : 'Paste the key exactly as the provider shows it, with no spaces.');
const model = (value: string) => (/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(value) ? null : 'Use the model name exactly as the provider lists it.');

export const SETTINGS: SettingSpec[] = [
  { key: 'OPENAI_API_KEY', group: 'chatgpt', label: 'API key', secret: true, help: 'From the API keys page of your OpenAI account.', validate: apiKey },
  { key: 'OPENAI_MODEL', group: 'chatgpt', label: 'Model', secret: false, help: 'A model OpenAI lists as supporting web search in the Responses API.', validate: model },
  { key: 'PERPLEXITY_API_KEY', group: 'perplexity', label: 'API key', secret: true, help: 'From the API settings of your Perplexity account.', validate: apiKey },
  { key: 'PERPLEXITY_MODEL', group: 'perplexity', label: 'Model', secret: false, help: 'A Sonar model name from Perplexity’s API documentation.', validate: model },
  { key: 'GEMINI_API_KEY', group: 'gemini', label: 'API key', secret: true, help: 'From Google AI Studio.', validate: apiKey },
  { key: 'GEMINI_MODEL', group: 'gemini', label: 'Model', secret: false, help: 'A Gemini model that supports grounding with Google Search.', validate: model },
  {
    key: 'WRITER_PROVIDER',
    group: 'writer',
    label: 'Provider',
    secret: false,
    help: 'Which company’s model writes briefs, drafts, FAQs and emails. OpenAI is used when nothing is chosen.',
    choices: [
      { value: 'openai', label: 'OpenAI (uses the ChatGPT key above)' },
      { value: 'anthropic', label: 'Claude (Anthropic)' },
      { value: 'gemini', label: 'Gemini (uses the Gemini key above)' },
    ],
    validate: (v) => (['openai', 'anthropic', 'gemini'].includes(v) ? null : 'Choose OpenAI, Claude or Gemini.'),
  },
  { key: 'WRITER_MODEL', group: 'writer', label: 'Writing model', secret: false, help: 'Optional for OpenAI and Gemini: without it, the engine model above is used. Required for Claude.', validate: model },
  { key: 'ANTHROPIC_API_KEY', group: 'writer', label: 'Claude API key', secret: true, help: 'Only needed when Claude is the provider. From the Anthropic Console.', validate: apiKey },
  {
    // Set on the Costs screen, not the API keys screen.
    key: 'USD_INR',
    group: 'billing',
    label: 'Rupees per US dollar',
    secret: false,
    help: 'Used to turn plan prices in rupees into dollars, to compare with costs.',
    validate: (v) => (/^\d{1,4}(\.\d{1,4})?$/.test(v) && Number(v) > 0 ? null : 'Enter a number, such as 84.5'),
  },
  {
    key: 'SMTP_URL',
    group: 'email',
    label: 'SMTP connection',
    secret: true,
    help: 'From your email provider, including the user name and password.',
    placeholder: 'smtps://user:password@smtp.example.com:465',
    validate: (v) => (/^smtps?:\/\/\S+$/.test(v) && v.length <= 1000 ? null : 'Start with smtp:// or smtps://, for example smtps://user:password@smtp.example.com:465'),
  },
  {
    key: 'MAIL_FROM',
    group: 'email',
    label: 'Send from address',
    secret: false,
    help: 'Every email comes from this address, with the agency’s name shown as the sender. Set up SPF and DKIM for its domain with your provider.',
    placeholder: 'no-reply@yourplatform.com',
    validate: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254 ? null : 'Enter an email address.'),
  },
];

export const specFor = (key: string) => SETTINGS.find((s) => s.key === key);

// Encryption -----------------------------------------------------------------

/** The 32-byte key from SETTINGS_ENCRYPTION_KEY, or null when it is missing or malformed. Read each time, never cached. */
function encryptionKey(): Buffer | null {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY ?? '';
  const key = Buffer.from(raw, 'base64');
  return key.length === 32 ? key : null;
}

export const encryptionReady = () => encryptionKey() !== null;

/** The setting's name is bound into the ciphertext, so a value cannot be moved to another setting's row. */
export function encrypt(name: string, plaintext: string): Buffer {
  const key = encryptionKey();
  if (!key) throw new Error('SETTINGS_ENCRYPTION_KEY is missing or is not 32 bytes in base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(name));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** Null when the value cannot be read: no key, a different key, or tampered data. */
export function decrypt(name: string, sealed: Buffer): string | null {
  const key = encryptionKey();
  if (!key || sealed.length < 29) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(sealed.subarray(12, 28));
    return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// In-memory copy ---------------------------------------------------------------

interface Saved {
  value: string | null;
  /** True when a secret is saved but cannot be decrypted with the current key. */
  unreadable: boolean;
  hint: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

let saved = new Map<string, Saved>();
let version = 0;

/** Increases whenever a re-read changes a value, so users of the settings know to rebuild. */
export const settingsVersion = () => version;

export async function refreshSettings(): Promise<void> {
  const { rows } = await ownerPool.query<{ key: string; value: string | null; secret: Buffer | null; hint: string | null; updated_at: Date; email: string | null }>(
    `SELECT s.key, s.value, s.secret, s.hint, s.updated_at, u.email FROM platform_settings s LEFT JOIN users u ON u.id = s.updated_by`,
  );
  const next = new Map<string, Saved>();
  for (const row of rows) {
    const value = row.secret ? decrypt(row.key, row.secret) : row.value;
    next.set(row.key, { value, unreadable: row.secret !== null && value === null, hint: row.hint, updatedAt: row.updated_at.toISOString(), updatedBy: row.email });
  }
  const before = JSON.stringify([...saved].map(([k, s]) => [k, s.value]));
  const after = JSON.stringify([...next].map(([k, s]) => [k, s.value]));
  saved = next;
  if (before !== after) version++;
}

/** The value in use: the saved one when there is a readable one, otherwise the environment variable. */
export function setting(key: string): string {
  const entry = saved.get(key);
  if (entry?.value) return entry.value;
  return process.env[key] ?? '';
}

export function settingState(key: string) {
  const entry = saved.get(key);
  const env = process.env[key] ?? '';
  return {
    source: entry?.value ? ('saved' as const) : env ? ('environment' as const) : ('none' as const),
    unreadable: entry?.unreadable ?? false,
    hint: entry?.hint ?? null,
    value: entry && !entry.unreadable ? entry.value : null,
    env,
    updatedAt: entry?.updatedAt ?? null,
    updatedBy: entry?.updatedBy ?? null,
  };
}

/** Re-reads every few seconds in the background. A failed read keeps the last good copy. */
export function startSettingsRefresh(onError: (err: unknown) => void, everyMs = 15_000): { stop(): void } {
  const timer = setInterval(() => refreshSettings().catch(onError), everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
