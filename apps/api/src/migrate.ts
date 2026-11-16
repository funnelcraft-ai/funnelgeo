import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

/**
 * Applies every migration in migrations/ that has not run yet, each in its own
 * transaction, in filename order. Run with the owner role.
 */
export async function migrate(ownerUrl: string, appPassword?: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
    }

    // The app role is created without a login by the first migration. Give it
    // one when a password is supplied (development, tests, first deploy).
    if (appPassword) {
      const quoted = await client.query<{ q: string }>('SELECT quote_literal($1) AS q', [appPassword]);
      await client.query(`ALTER ROLE geo_app LOGIN PASSWORD ${quoted.rows[0]!.q}`);
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ownerUrl = process.env.DATABASE_OWNER_URL;
  if (!ownerUrl) throw new Error('DATABASE_OWNER_URL is not set');
  const applied = await migrate(ownerUrl, process.env.APP_DB_PASSWORD);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
}
