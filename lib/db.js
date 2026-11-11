import pg from 'pg';
import { readFile } from 'node:fs/promises';

// Keep DATE columns as 'YYYY-MM-DD' strings. The default parser turns them into
// local-midnight Date objects, which shift a day when serialised to UTC.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/project_tracking';

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

export async function applySchema() {
  const sql = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

// Turns connection failures into a message that says what to run.
export function describeDbError(err) {
  if (err.code === '3D000') return `The database in ${DATABASE_URL} doesn't exist yet. Run \`npm run setup\` first.`;
  if (err.code === 'ECONNREFUSED') return `Can't reach Postgres at ${DATABASE_URL}. Start it with \`brew services start postgresql@18\`.`;
  return null;
}
