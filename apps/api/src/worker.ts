import { createMockSiteFetcher, createSiteFetcher } from './audits/fetch.js';
import { config } from './config.js';
import { closePools } from './db.js';
import { createEngines } from './engines.js';
import { createMailer } from './mailer.js';
import { createQueue, startWorkers } from './queue.js';
import { startScheduler } from './scheduler.js';
import { refreshSettings, startSettingsRefresh } from './settings.js';

// The background process: makes the engine calls, checks prospects' websites,
// turns website leads into audits, sends the audit emails and starts the weekly runs.
// Run one or more of these beside the API. The API only puts calls on the queue.

// API keys saved on the super admin screen, re-read every 15 seconds so a new
// key is used without restarting this process.
await refreshSettings();
const settingsRefresh = startSettingsRefresh((err) => console.error(JSON.stringify({ message: 'settings refresh failed', error: String(err) })));

const engines = createEngines();
const queue = createQueue();
const log = (message: string, extra?: unknown) => console.log(JSON.stringify({ time: new Date().toISOString(), message, ...(extra ? { extra: String(extra) } : {}) }));

const mailer = createMailer();
const fetcher = config.siteFetch === 'mock' ? createMockSiteFetcher() : createSiteFetcher();
const workers = startWorkers(engines, {
  onError: (err) => log('worker error', err),
  audit: { fetcher, mailer, queue, siteMode: config.siteFetch },
});
const scheduler = startScheduler({ engines, queue, mailer }, (err) => log('scheduler error', err));

log(`worker started: engines ${[...engines.available.keys()].join(', ') || 'none'} (${engines.mode} mode)`);
if (engines.available.size === 0) log('no engine has both an API key and a model set yet; add them on the API keys screen');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    scheduler.stop();
    settingsRefresh.stop();
    await workers.close(); // waits for calls in progress
    await queue.close();
    await closePools();
    process.exit(0);
  });
}
