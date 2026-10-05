// Separate process configuration: never change .env or the running test server.
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { DatabaseSync, backup } from 'node:sqlite';
process.env.PORT = '24173';
process.env.ROAMLY_HOST = '127.0.0.1';
process.env.ROAMLY_DB = path.resolve(import.meta.dirname, '../data/production.sqlite');
// Enable the requested monitor for this deployment; an explicit 0 still disables it.
process.env.ROAMLY_AI_MONITOR ??= '1';
mkdirSync(path.dirname(process.env.ROAMLY_DB), { recursive: true });
const existing = path.resolve(import.meta.dirname, '../data/roamly.sqlite');
if (!existsSync(process.env.ROAMLY_DB) && existsSync(existing)) {
  const source = new DatabaseSync(existing, { readOnly: true });
  try { await backup(source, process.env.ROAMLY_DB); }
  finally { source.close(); }
  console.log('Created initial production database snapshot; subsequent test data is independent.');
}
process.argv.push('--production');
await import('../server/index.mjs');
