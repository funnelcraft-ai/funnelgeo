import { resolveCname as dnsResolveCname } from 'node:dns/promises';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { HttpError } from './http.js';
import { adminRoutes } from './routes/admin.js';
import { agencyRoutes, type CnameResolver } from './routes/agency.js';
import { authRoutes } from './routes/auth.js';
import { clientRoutes } from './routes/clients.js';
import { teamRoutes } from './routes/team.js';
import { isTrustedProxy, requestHost, resolveTenant } from './tenant.js';

export interface AppOptions {
  /** DNS lookup used to verify custom domains. Replaced in tests. */
  resolveCname?: CnameResolver;
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: config.isTest ? false : { level: 'info' } });

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

  await app.register(authRoutes);
  await app.register(agencyRoutes, { resolveCname: options.resolveCname ?? dnsResolveCname });
  await app.register(teamRoutes);
  await app.register(clientRoutes);
  await app.register(adminRoutes);

  return app;
}
