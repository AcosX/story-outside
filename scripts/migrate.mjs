#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import mysql from 'mysql2/promise';
import { loadDatabaseConfig } from '../src/db/mariadb.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

export function splitMigrationStatements(sql) {
  let delimiter = ';';
  let buffer = '';
  const statements = [];
  for (const line of sql.split(/\r?\n/)) {
    const directive = line.match(/^\s*DELIMITER\s+(\S+)\s*$/i);
    if (directive) {
      delimiter = directive[1];
      continue;
    }
    buffer += `${line}\n`;
    if (buffer.trimEnd().endsWith(delimiter)) {
      const statement = buffer.trimEnd().slice(0, -delimiter.length).trim();
      if (statement) statements.push(statement);
      buffer = '';
    }
  }
  if (buffer.trim()) statements.push(buffer.trim());
  return statements;
}

const config = loadDatabaseConfig();
if (!config) {
  console.error('STORY_OUTSIDE_DATABASE_URL is required');
  process.exit(1);
}

const connection = await mysql.createConnection({ ...config, multipleStatements: true });
try {
  const [lockRows] = await connection.query("SELECT GET_LOCK('story_outside_migrations', 10) AS acquired");
  if (lockRows[0].acquired !== 1) throw new Error('could not acquire migration lock');

  const names = (await readdir(join(root, 'db', 'migrations')))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  for (const name of names) {
    const [rows] = await connection.query(
      'SELECT 1 FROM schema_migrations WHERE migration_name = ? LIMIT 1',
      [name.replace(/\.sql$/, '')],
    ).catch(() => [[]]);
    if (rows.length) {
      console.log(`skip  ${name}`);
      continue;
    }
    const sql = await readFile(join(root, 'db', 'migrations', name), 'utf8');
    for (const statement of splitMigrationStatements(sql)) {
      await connection.query(statement);
    }
    console.log(`apply ${name}`);
  }
} finally {
  await connection.query("SELECT RELEASE_LOCK('story_outside_migrations')").catch(() => {});
  await connection.end();
}
