import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { ownerPool } from '../db.js';
import { brandFor } from '../emails.js';
import { liveEngine, type EngineKey } from '../engines.js';
import { HttpError, notFound, parse, requireRole } from '../http.js';
import type { Mailer } from '../mailer.js';
import { SETTINGS, encrypt, encryptionReady, refreshSettings, settingState, specFor, type SettingGroup } from '../settings.js';

const GROUPS: { key: SettingGroup; label: string; description: string }[] = [
  { key: 'chatgpt', label: 'ChatGPT', description: 'OpenAI API, with web search. Used to ask ChatGPT the tracked questions.' },
  { key: 'perplexity', label: 'Perplexity', description: 'Perplexity Sonar API. Also used to suggest competitors for audits.' },
  { key: 'gemini', label: 'Gemini', description: 'Google Gemini API, with grounding in Google Search.' },
  { key: 'email', label: 'Email', description: 'The SMTP server that sends invites, password resets, audit reports and lead alerts.' },
];

const TEST_TIMEOUT_MS = 45_000;

/** Turns "HTTP 401: {json}" from an engine into the provider's own words. */
export function explainEngineError(err: unknown): string {
  const raw = String((err as Error)?.message ?? err).replace(/\s+/g, ' ');
  if ((err as Error)?.name === 'TimeoutError') return `No answer within ${TEST_TIMEOUT_MS / 1000} seconds.`;
  const http = raw.match(/^HTTP (\d{3}): (.*)$/);
  if (!http) return raw.slice(0, 300);
  const status = Number(http[1]);
  let detail = http[2]!;
  try {
    const body = JSON.parse(detail);
    const found = body?.error?.message ?? body?.message ?? (typeof body?.error === 'string' ? body.error : null);
    if (typeof found === 'string') detail = found;
  } catch {
    // Not JSON: keep the text as it came.
  }
  const why = status === 401 || status === 403 ? 'The provider rejected the key' : status === 404 ? 'The provider does not recognise this model or address' : status === 429 ? 'The provider is limiting requests or the account is out of credit' : `The provider answered with error ${status}`;
  return `${why}: ${detail}`.slice(0, 300);
}

/** What the screen shows for one setting. A secret is never sent back, only its last four characters. */
function present(key: string) {
  const spec = specFor(key)!;
  const state = settingState(key);
  const envHint = spec.secret ? state.env.slice(-4) : state.env;
  return {
    key,
    label: spec.label,
    secret: spec.secret,
    help: spec.help,
    placeholder: spec.placeholder ?? null,
    source: state.source,
    unreadable: state.unreadable,
    shown: state.source === 'saved' ? (spec.secret ? state.hint : state.value) : state.source === 'environment' ? envHint : null,
    updatedAt: state.updatedAt,
    updatedBy: state.updatedBy,
  };
}

/**
 * The API keys screen. Super admin only: requireRole('super_admin') succeeds
 * only on the platform's own address, never on an agency's.
 */
export async function settingsRoutes(app: FastifyInstance, opts: { mailer: Mailer }): Promise<void> {
  const guard = { preHandler: requireRole('super_admin') };
  const keyParam = z.object({ key: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/) });

  app.get('/v1/admin/settings', guard, async () => {
    await refreshSettings();
    return {
      encryptionReady: encryptionReady(),
      engineMode: config.engineMode,
      groups: GROUPS.map((g) => ({ ...g, items: SETTINGS.filter((s) => s.group === g.key).map((s) => present(s.key)) })),
    };
  });

  app.put('/v1/admin/settings/:key', guard, async (req) => {
    const { key } = parse(keyParam, req.params);
    const spec = specFor(key);
    if (!spec) throw notFound('Unknown setting');
    const { value } = parse(z.object({ value: z.string().trim().min(1).max(2000) }).strict(), req.body);
    const problem = spec.validate(value);
    if (problem) throw new HttpError(400, 'invalid_input', problem);

    if (spec.secret) {
      if (!encryptionReady()) {
        throw new HttpError(409, 'encryption_not_ready', 'Keys cannot be saved until SETTINGS_ENCRYPTION_KEY is set on the server. See the note at the top of this page.');
      }
      await ownerPool.query(
        `INSERT INTO platform_settings (key, secret, hint, updated_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET value = NULL, secret = EXCLUDED.secret, hint = EXCLUDED.hint, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, encrypt(key, value), value.slice(-4), req.user!.id],
      );
    } else {
      await ownerPool.query(
        `INSERT INTO platform_settings (key, value, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, secret = NULL, hint = NULL, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, value, req.user!.id],
      );
    }
    req.log.info({ setting: key, by: req.user!.email }, 'platform setting saved');
    await refreshSettings();
    return { setting: present(key) };
  });

  /** Removes the saved value. The environment variable, if any, is used again. */
  app.delete('/v1/admin/settings/:key', guard, async (req) => {
    const { key } = parse(keyParam, req.params);
    if (!specFor(key)) throw notFound('Unknown setting');
    await ownerPool.query(`DELETE FROM platform_settings WHERE key = $1`, [key]);
    req.log.info({ setting: key, by: req.user!.email }, 'platform setting removed');
    await refreshSettings();
    return { setting: present(key) };
  });

  /**
   * Makes one real call with the settings as they are now: a short question to
   * an engine (a fraction of a cent), or a test email to the super admin's own
   * address. Rate limited, since each call costs money.
   */
  app.post(
    '/v1/admin/settings/test/:target',
    { ...guard, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const { target } = parse(z.object({ target: z.enum(['chatgpt', 'perplexity', 'gemini', 'email']) }), req.params);
      await refreshSettings();

      if (target === 'email') {
        if (!opts.mailer.enabled) return { ok: false, message: 'No SMTP connection is set.' };
        const started = performance.now();
        try {
          const brand = brandFor({ kind: 'platform' });
          await opts.mailer.send({
            to: req.user!.email,
            fromName: brand.fromName,
            subject: `${config.platformName} test email`,
            text: `This is a test email from ${config.platformName}. If you can read it, email is set up correctly.`,
            html: `<p>This is a test email from ${config.platformName}. If you can read it, email is set up correctly.</p>`,
          });
          return { ok: true, message: `Sent to ${req.user!.email}. Check that it arrived, including the spam folder.`, latencyMs: Math.round(performance.now() - started) };
        } catch (err) {
          return { ok: false, message: String((err as Error)?.message ?? err).slice(0, 300) };
        }
      }

      const engine = liveEngine(target as EngineKey);
      if (!engine) return { ok: false, message: 'Set both the API key and the model first.' };
      const started = performance.now();
      try {
        const answer = await engine.ask('In one short sentence, what is a search engine?', AbortSignal.timeout(TEST_TIMEOUT_MS));
        if (!answer.text.trim()) return { ok: false, message: 'The engine answered, but with no text.' };
        return {
          ok: true,
          message: `Answered in ${((performance.now() - started) / 1000).toFixed(1)} s with ${answer.citations.length} ${answer.citations.length === 1 ? 'source' : 'sources'}.`,
          sample: answer.text.slice(0, 240),
          latencyMs: Math.round(performance.now() - started),
          citations: answer.citations.length,
        };
      } catch (err) {
        return { ok: false, message: explainEngineError(err) };
      }
    },
  );
}
