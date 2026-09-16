// Minimal, dependency-free migration runner. Reads every *.sql file in
// db/migrations (repo-relative, resolved from this file's location), tracks
// applied migrations in a `schema_migrations` table, and applies any pending
// ones in order inside a transaction. Each migration runs as a single
// transaction; on failure it rolls back and aborts.
//
// Run: `npm run migrate` (or `tsx src/db/migrate.ts`). Exits 0 on success.
import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../../../db/migrations');

const env = z
  .object({ DATABASE_URL: z.string().min(1) })
  .parse(process.env);

async function main() {
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      )
    `);
    const { rows } = await client.query('select filename from schema_migrations order by filename');
    const applied = new Set(rows.map((r) => r.filename));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`[migrate] applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (filename) values ($1)', [file]);
        await client.query('COMMIT');
        count++;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`[migrate] FAILED on ${file}:`, err instanceof Error ? err.message : err);
        process.exitCode = 1;
        return;
      }
    }
    console.log(`[migrate] done (${count} applied, ${applied.size} already present)`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[migrate] error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
