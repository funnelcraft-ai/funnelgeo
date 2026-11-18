import { resolveCname as dnsResolveCname } from 'node:dns/promises';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { HttpError } from './http.js';
import { createMailer, type Mailer } from './mailer.js';
import { adminRoutes } from './routes/admin.js';
import { agencyRoutes, type CnameResolver } from './routes/agency.js';
import { authRoutes } from './routes/auth.js';
import { clientRoutes } from './routes/clients.js';
import { fileRoutes } from './routes/files.js';
import { teamRoutes } from './routes/team.js';
import { trackerRoutes } from './routes/tracker.js';
import { createEngines, type EngineSet } from './engines.js';
import { createQueue } from './queue.js';
import type { CallQueue } from './tracker/runs.js';
import { auditRoutes } from './routes/audits.js';
import { settingsRoutes } from './routes/settings.js';
import { diagnosisRoutes } from './routes/diagnosis.js';
import { actionRoutes } from './routes/actions.js';
import { proofRoutes } from './routes/proof.js';
import { reportRoutes } from './routes/reports.js';
import { billingRoutes } from './routes/billing.js';
import { createWriter, type Writer } from './writer.js';
import { refreshSettings, startSettingsRefresh } from './settings.js';
import type { TaskQueue } from './audits/pipeline.js';
import { isTrustedProxy, requestHost, resolveTenant } from './tenant.js';

export interface AppOptions {
  /** DNS lookup used to verify custom domains. Replaced in tests. */
  resolveCname?: CnameResolver;
  /** Outgoing email. Replaced in tests. */
  mailer?: Mailer;
  /** Writes action assets; the configured writing model when not given. */
  writer?: Writer;
  /** Answer engines. Replaced in tests. */
  engines?: EngineSet;
  /** Where engine calls are queued for the worker. Replaced in tests. */
  queue?: CallQueue;
  /** Where site checks and website leads are queued. Replaced in tests. */
  tasks?: TaskQueue;
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: config.isTest ? false : { level: 'info' } });

  // Saved API keys and settings, re-read in the background so changes made
  // by another process reach this one within seconds.
  await refreshSettings();
  const settingsRefresh = startSettingsRefresh((err) => app.log.error(err));
  app.addHook('onClose', async () => settingsRefresh.stop());

  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    // Behind the web app every request arrives from the same address, so use
    // the visitor's address it forwards, but only when the caller is trusted.
    keyGenerator: (req) => {
      const forwarded = req.headers['x-forwarded-for'];
      if (isTrustedProxy(req) && typeof forwarded === 'string' && forwarded) {
        return (forwarded.split(',')[0] ?? '').trim() || req.ip;
      }
      return req.ip;
    },
  });

  app.decorateRequest('tenant', null as never);
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req) => {
    req.tenant = await resolveTenant(requestHost(req));
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err?.statusCode === 413) {
      return reply.code(413).send({ error: { code: 'too_large', message: 'That file is too large. The limit is 1 MB.' } });
    }
    if (err?.statusCode === 415) {
      return reply.code(415).send({ error: { code: 'invalid_image', message: 'Upload a PNG, JPEG or WebP image' } });
    }
    if (err?.statusCode === 429) {
      return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many attempts. Try again in a minute.' } });
    }
    if (err?.code === '23505') {
      return reply.code(409).send({ error: { code: 'conflict', message: 'That already exists' } });
    }
    if (err?.code === '42501') {
      // The database refused a write under row-level security.
      return reply.code(403).send({ error: { code: 'forbidden', message: 'You do not have access to this' } });
    }
    if (typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: 'bad_request', message: err.message } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong' } });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  const mailer = options.mailer ?? createMailer();
  await app.register(authRoutes, { mailer });
  await app.register(agencyRoutes, { resolveCname: options.resolveCname ?? dnsResolveCname });
  await app.register(fileRoutes);
  await app.register(teamRoutes, { mailer });
  await app.register(clientRoutes);
  await app.register(adminRoutes);
  await app.register(settingsRoutes, { mailer });

  const engines = options.engines ?? createEngines();
  let own: ReturnType<typeof createQueue> | null = null;
  const ownQueue = () => {
    if (!own) {
      own = createQueue();
      const created = own;
      app.addHook('onClose', () => created.close());
    }
    return own;
  };
  const queue = options.queue ?? ownQueue();
  const tasks = options.tasks ?? ('siteAudit' in queue ? (queue as unknown as TaskQueue) : ownQueue());
  await app.register(trackerRoutes, { engines, queue });
  await app.register(auditRoutes, { engines, queue, tasks, siteMode: config.siteFetch });
  await app.register(diagnosisRoutes, { tasks, siteMode: config.siteFetch });
  const writer = options.writer ?? createWriter();
  await app.register(actionRoutes, { tasks, writer });
  await app.register(proofRoutes);
  await app.register(reportRoutes, { tasks, writer });
  await app.register(billingRoutes);

  return app;
}
