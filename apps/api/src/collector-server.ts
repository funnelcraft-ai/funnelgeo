import { config } from './config.js';
import { buildCollector } from './proof/collector.js';

// The visit collector runs as its own process: clients' website traffic
// never shares a process with the dashboard API.
const app = await buildCollector();
await app.listen({ port: config.collectorPort, host: process.env.HOST ?? '127.0.0.1' });
console.log(JSON.stringify({ time: new Date().toISOString(), message: `collector listening on ${config.collectorPort}` }));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
