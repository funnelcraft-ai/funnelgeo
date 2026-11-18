import { agencyHost, originFor } from '../config.js';
import { ownerPool, withSystem, type Db } from '../db.js';
import { brandFor, usageAlertEmail } from '../emails.js';
import type { Mailer } from '../mailer.js';
import { setting } from '../settings.js';
import type { Agency } from '../tenant.js';

/**
 * Credits for agencies; real cost and margin for the super admin.
 *
 * "Used" is credits spent this month: reservations net of refunds. Grants
 * and adjustments from the super admin raise or lower what's available but
 * are not usage.
 */

/** Ledger reasons that are usage (spend and refunds of it), by what they paid for. */
const SPEND = `reason IN ('run_reserved', 'run_refund', 'asset_reserved', 'asset_refund', 'summary_reserved', 'summary_refund')`;
const MONTH_START = `date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

/** This month's credits for one agency, as its owners see them, with a forecast to month end. */
export async function agencyUsage(db: Db, agencyId: string) {
  const { rows: head } = await db.query(
    `SELECT p.name AS plan, p.monthly_credits, p.samples_per_prompt, a.topup_enabled, a.topup_limit,
            credits_remaining(a.id) AS remaining, credits_spendable(a.id) AS spendable,
            coalesce((SELECT sum(delta) FROM credit_ledger WHERE agency_id = a.id AND reason IN ('grant', 'adjustment') AND created_at >= ${MONTH_START}), 0)::int AS granted,
            coalesce((SELECT -sum(delta) FROM credit_ledger WHERE agency_id = a.id AND ${SPEND} AND created_at >= ${MONTH_START}), 0)::int AS used
       FROM agencies a JOIN plans p ON p.id = a.plan_id WHERE a.id = $1`,
    [agencyId],
  );
  const h = head[0]!;
  const available = h.monthly_credits + h.granted;

  // What the spending went on, and for which client.
  const { rows: lines } = await db.query<{ kind: string; client: string | null; credits: number }>(
    `SELECT CASE
              WHEN l.run_id IS NOT NULL THEN CASE WHEN r.trigger = 'audit' THEN 'audits' WHEN r.trigger = 'scheduled' THEN 'scheduled_runs' ELSE 'manual_runs' END
              WHEN l.asset_id IS NOT NULL THEN 'assets'
              WHEN l.report_id IS NOT NULL THEN 'summaries'
              ELSE 'other' END AS kind,
            coalesce(c1.name, c2.name, c3.name) AS client,
            -sum(l.delta)::int AS credits
       FROM credit_ledger l
       LEFT JOIN runs r ON r.id = l.run_id
       LEFT JOIN clients c1 ON c1.id = r.client_id
       LEFT JOIN assets s ON s.id = l.asset_id
       LEFT JOIN clients c2 ON c2.id = s.client_id
       LEFT JOIN reports rp ON rp.id = l.report_id
       LEFT JOIN clients c3 ON c3.id = rp.client_id
      WHERE l.agency_id = $1 AND ${SPEND.replace('reason', 'l.reason')} AND l.created_at >= ${MONTH_START}
      GROUP BY 1, 2`,
    [agencyId],
  );
  const byKind = ['scheduled_runs', 'manual_runs', 'audits', 'assets', 'summaries'].map((kind) => ({
    kind,
    credits: lines.filter((l) => l.kind === kind).reduce((s, l) => s + l.credits, 0),
  }));
  const clients = new Map<string, number>();
  for (const l of lines) if (l.kind !== 'audits' && l.client) clients.set(l.client, (clients.get(l.client) ?? 0) + l.credits);
  const byClient = [...clients].map(([name, credits]) => ({ name, credits })).sort((a, b) => b.credits - a.credits);

  const { rows: daily } = await db.query<{ day: string; credits: number }>(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, coalesce(-sum(l.delta), 0)::int AS credits
       FROM generate_series(date_trunc('month', now() AT TIME ZONE 'UTC'), date_trunc('day', now() AT TIME ZONE 'UTC'), interval '1 day') AS d(day)
       LEFT JOIN credit_ledger l ON l.agency_id = $1 AND ${SPEND.replace('reason', 'l.reason')}
            AND (l.created_at AT TIME ZONE 'UTC') >= d.day AND (l.created_at AT TIME ZONE 'UTC') < d.day + interval '1 day'
      GROUP BY d.day ORDER BY d.day`,
    [agencyId],
  );

  // Forecast: scheduled runs still to come this month, at today's cost per run,
  // plus everything else at this month's daily rate so far.
  const { rows: scheduled } = await db.query<{ runs: number; credits_per_run: number }>(
    `SELECT c.id,
            (SELECT count(*) FROM generate_series(c.next_run_at, date_trunc('month', now()) + interval '1 month' - interval '1 second', interval '7 days'))::int AS runs,
            ((SELECT count(*) FROM prompts p WHERE p.client_id = c.id AND p.active) * $1
              * (SELECT coalesce(sum(credit_cost), 0) FROM engines WHERE active))::int AS credits_per_run
       FROM clients c WHERE c.schedule = 'weekly' AND c.status = 'active' AND c.next_run_at IS NOT NULL`,
    [h.samples_per_prompt],
  );
  const scheduledAhead = scheduled.reduce((s, c) => s + c.runs * c.credits_per_run, 0);
  const now = new Date();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const daysSoFar = now.getUTCDate();
  const otherSoFar = h.used - (byKind.find((k) => k.kind === 'scheduled_runs')?.credits ?? 0);
  const otherAhead = Math.round((Math.max(otherSoFar, 0) / daysSoFar) * (daysInMonth - daysSoFar));
  const forecast = h.used + scheduledAhead + otherAhead;

  return {
    plan: h.plan as string,
    allowance: h.monthly_credits as number,
    granted: h.granted as number,
    available,
    used: h.used as number,
    remaining: h.remaining as number,
    spendable: h.spendable as number,
    percentUsed: available > 0 ? h.used / available : 1,
    topup: { enabled: h.topup_enabled as boolean, limit: h.topup_limit as number, inUse: Math.max(0, -(h.remaining as number)) },
    byKind,
    byClient,
    daily,
    forecast: { credits: forecast, scheduledAhead, otherAhead, daysLeft: daysInMonth - daysSoFar, overBy: Math.max(0, forecast - available) },
  };
}

/**
 * Emails owners once a month at 80% of the allowance and once at 100%.
 * Called hourly by the scheduler.
 */
export async function checkUsageAlerts(mailer: Mailer, now = new Date()): Promise<number> {
  const month = now.toISOString().slice(0, 7);
  const { rows } = await ownerPool.query(
    `SELECT a.id, a.name, a.slug, a.custom_domain, a.domain_status, a.branding, a.status, a.plan_id, a.widget_enabled,
            a.topup_enabled, a.topup_limit, a.alert_80_month, a.alert_100_month,
            p.monthly_credits + coalesce((SELECT sum(delta) FROM credit_ledger WHERE agency_id = a.id AND reason IN ('grant', 'adjustment') AND created_at >= ${MONTH_START}), 0) AS available,
            coalesce((SELECT -sum(delta) FROM credit_ledger WHERE agency_id = a.id AND ${SPEND} AND created_at >= ${MONTH_START}), 0) AS used
       FROM agencies a JOIN plans p ON p.id = a.plan_id WHERE a.status = 'active'`,
  );
  let sent = 0;
  for (const a of rows) {
    const available = Number(a.available);
    const used = Number(a.used);
    if (available <= 0) continue;
    const level = used >= available ? 100 : used >= available * 0.8 ? 80 : 0;
    if (level === 0 || (level === 100 && a.alert_100_month === month) || (level === 80 && (a.alert_80_month === month || a.alert_100_month === month))) continue;
    await ownerPool.query(
      level === 100 ? `UPDATE agencies SET alert_100_month = $2, alert_80_month = $2 WHERE id = $1` : `UPDATE agencies SET alert_80_month = $2 WHERE id = $1`,
      [a.id, month],
    );
    const { rows: owners } = await ownerPool.query<{ email: string }>(`SELECT email FROM users WHERE agency_id = $1 AND role = 'agency_owner'`, [a.id]);
    const agency = a as Agency;
    const brand = brandFor({ kind: 'agency', agency });
    for (const o of owners) {
      await mailer
        .send(usageAlertEmail(brand, { to: o.email, level, used, available, topup: a.topup_enabled ? Number(a.topup_limit) : null, url: `${originFor(agencyHost(agency))}/usage` }))
        .catch(() => {});
    }
    sent++;
  }
  return sent;
}

// Super admin --------------------------------------------------------------------

/** First day of a 'YYYY-MM' month, and of the next. */
function monthRange(month: string): [string, string] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return [new Date(Date.UTC(y, m - 1, 1)).toISOString(), new Date(Date.UTC(y, m, 1)).toISOString()];
}

/** Within this share of the invoice, recorded costs count as matching (PRD exit check). */
export const INVOICE_TOLERANCE = 0.05;

/** Credits, real cost, revenue and margin per agency for a month; providers against their invoices. */
export async function costReport(month: string) {
  const [from, to] = monthRange(month);
  const fx = Number(setting('USD_INR')) || null;
  const toUsd = (cents: number | null, currency: string | null) =>
    cents === null || !currency ? null : currency === 'USD' ? cents / 100 : fx ? cents / 100 / fx : null;

  return withSystem(async (db) => {
    const { rows: agencies } = await db.query(
      `SELECT a.id, a.name, a.slug, a.status, a.topup_enabled, p.name AS plan, p.monthly_credits, p.price_cents, p.currency,
              coalesce((SELECT sum(delta) FROM credit_ledger l WHERE l.agency_id = a.id AND l.reason IN ('grant', 'adjustment') AND l.created_at >= $1 AND l.created_at < $2), 0)::int AS granted,
              coalesce((SELECT -sum(delta) FROM credit_ledger l WHERE l.agency_id = a.id AND ${SPEND.replace('reason', 'l.reason')} AND l.created_at >= $1 AND l.created_at < $2), 0)::int AS used,
              coalesce((SELECT sum(cost_usd) FROM usage_costs u WHERE u.agency_id = a.id AND u.occurred_at >= $1 AND u.occurred_at < $2), 0)::float AS cost_usd,
              (SELECT count(*) FROM usage_costs u WHERE u.agency_id = a.id AND u.occurred_at >= $1 AND u.occurred_at < $2 AND u.cost_usd IS NULL)::int AS unpriced,
              (SELECT count(*) FROM usage_events u WHERE u.agency_id = a.id AND u.occurred_at >= $1 AND u.occurred_at < $2 AND u.kind = 'engine_call')::int AS engine_calls
         FROM agencies a JOIN plans p ON p.id = a.plan_id ORDER BY a.name`,
      [from, to],
    );
    const { rows: platform } = await db.query(
      `SELECT coalesce(sum(cost_usd), 0)::float AS cost_usd, count(*) FILTER (WHERE cost_usd IS NULL)::int AS unpriced
         FROM usage_costs WHERE agency_id IS NULL AND occurred_at >= $1 AND occurred_at < $2`,
      [from, to],
    );
    const { rows: providers } = await db.query(
      `WITH used AS (
         SELECT provider, coalesce(sum(cost_usd), 0)::float AS cost_usd, count(*)::int AS events,
                count(*) FILTER (WHERE cost_usd IS NULL)::int AS unpriced
           FROM usage_costs WHERE occurred_at >= $1 AND occurred_at < $2 AND provider NOT IN ('mock', 'crawl') GROUP BY provider)
       SELECT coalesce(u.provider, i.provider) AS provider, coalesce(u.cost_usd, 0) AS cost_usd, coalesce(u.events, 0) AS events,
              coalesce(u.unpriced, 0) AS unpriced, i.amount_usd::float AS invoice_usd, i.note
         FROM used u FULL JOIN (SELECT * FROM provider_invoices WHERE month = $1::date) i ON i.provider = u.provider
        ORDER BY 1`,
      [from, to],
    );
    const { rows: models } = await db.query(
      `SELECT u.provider, u.model, count(*)::int AS events, sum(u.requests)::int AS requests,
              sum(u.tokens_in)::bigint AS tokens_in, sum(u.tokens_out)::bigint AS tokens_out,
              coalesce(sum(u.cost_usd), 0)::float AS cost_usd, bool_or(u.cost_usd IS NULL) AS unpriced,
              bool_or(u.provider_cost_usd IS NOT NULL) AS provider_reported
         FROM usage_costs u WHERE u.occurred_at >= $1 AND u.occurred_at < $2 AND u.provider <> 'mock'
        GROUP BY 1, 2 ORDER BY 1, 2`,
      [from, to],
    );
    const { rows: prices } = await db.query(`SELECT provider, model, input_per_mtok::float, output_per_mtok::float, per_request::float, updated_at FROM model_prices ORDER BY provider, model`);

    const rowsOut = agencies.map((a) => {
      const available = a.monthly_credits + a.granted;
      const revenue = toUsd(a.price_cents, a.currency);
      return {
        id: a.id as string,
        name: a.name as string,
        slug: a.slug as string,
        status: a.status as string,
        plan: a.plan as string,
        allowance: a.monthly_credits as number,
        granted: a.granted as number,
        used: a.used as number,
        overage: Math.max(0, a.used - available),
        topupEnabled: a.topup_enabled as boolean,
        engineCalls: a.engine_calls as number,
        costUsd: a.cost_usd as number,
        unpriced: a.unpriced as number,
        costPerCredit: a.used > 0 ? a.cost_usd / a.used : null,
        price: a.price_cents === null ? null : { amount: a.price_cents / 100, currency: a.currency as string },
        revenueUsd: revenue,
        marginUsd: revenue === null ? null : revenue - a.cost_usd,
        marginPct: revenue ? (revenue - a.cost_usd) / revenue : null,
      };
    });
    return {
      month,
      fx: { usdInr: fx },
      agencies: rowsOut,
      platformCostUsd: platform[0]!.cost_usd as number,
      platformUnpriced: platform[0]!.unpriced as number,
      totals: {
        costUsd: rowsOut.reduce((s, a) => s + a.costUsd, 0) + (platform[0]!.cost_usd as number),
        revenueUsd: rowsOut.some((a) => a.revenueUsd !== null) ? rowsOut.reduce((s, a) => s + (a.revenueUsd ?? 0), 0) : null,
        used: rowsOut.reduce((s, a) => s + a.used, 0),
        unpriced: rowsOut.reduce((s, a) => s + a.unpriced, 0) + (platform[0]!.unpriced as number),
      },
      providers: providers.map((p) => {
        const diff = p.invoice_usd ? (p.cost_usd - p.invoice_usd) / p.invoice_usd : null;
        return {
          provider: p.provider as string,
          costUsd: p.cost_usd as number,
          events: p.events as number,
          unpriced: p.unpriced as number,
          invoiceUsd: (p.invoice_usd as number | null) ?? null,
          note: (p.note as string | null) ?? null,
          difference: diff,
          // Matching needs an invoice, every call priced, and the totals within 5%.
          matches: diff === null ? null : p.unpriced === 0 && Math.abs(diff) <= INVOICE_TOLERANCE,
        };
      }),
      models: models.map((m) => ({
        provider: m.provider as string,
        model: m.model as string,
        events: m.events as number,
        requests: m.requests as number,
        tokensIn: Number(m.tokens_in),
        tokensOut: Number(m.tokens_out),
        costUsd: m.cost_usd as number,
        unpriced: m.unpriced as boolean,
        providerReported: m.provider_reported as boolean,
      })),
      prices: prices.map((p) => ({ provider: p.provider, model: p.model, inputPerMTok: p.input_per_mtok, outputPerMTok: p.output_per_mtok, perRequest: p.per_request, updatedAt: p.updated_at })),
    };
  });
}
