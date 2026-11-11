// Creates the database named in DATABASE_URL if it's missing, then applies the schema.
import pg from 'pg';
import { DATABASE_URL, applySchema, describeDbError, pool } from '../lib/db.js';

const target = new URL(DATABASE_URL);
const dbName = decodeURIComponent(target.pathname.slice(1));
const maintenance = new URL(DATABASE_URL);
maintenance.pathname = '/postgres';

const admin = new pg.Client({ connectionString: maintenance.toString() });
try {
  await admin.connect();
  const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [dbName]);
  if (rowCount) {
    console.log(`Database "${dbName}" already exists`);
  } else {
    await admin.query(`create database ${pg.escapeIdentifier(dbName)}`);
    console.log(`Created database "${dbName}"`);
  }
  await admin.end();

  await applySchema();
  console.log('Schema is up to date');
} catch (err) {
  console.error(describeDbError(err) ?? err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
