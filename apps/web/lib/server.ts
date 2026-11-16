import { cache } from 'react';
import { headers } from 'next/headers';
import type { Session, Tenant } from './types';

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4000';

/**
 * Calls the API from a server component on behalf of the current visitor:
 * forwards the hostname they used (which decides the tenant) and their cookie.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const incoming = await headers();
  return fetch(`${API_URL}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      'x-forwarded-host': incoming.get('host') ?? '',
      'x-forwarded-for': incoming.get('x-forwarded-for') ?? '',
      'x-proxy-secret': process.env.INTERNAL_PROXY_SECRET ?? '',
      cookie: incoming.get('cookie') ?? '',
    },
  });
}

export async function apiGet<T>(path: string): Promise<T | null> {
  const res = await apiFetch(path);
  return res.ok ? ((await res.json()) as T) : null;
}

/** Who this hostname belongs to. Cached for the duration of one request. */
export const getTenant = cache(async (): Promise<Tenant | null> => apiGet<Tenant>('/v1/tenant'));

export const getSession = cache(async (): Promise<Session | null> => apiGet<Session>('/v1/me'));
