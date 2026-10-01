import { DatabaseSync } from 'node:sqlite';
import { createStateSchema } from './store.mjs';

const maxSql = 65_536;
const expected = new Map();
const token = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?|<>|!=|<=|>=|\|\||[^\s]/g;

function normalized(sql) {
  if (sql === null) return null;
  // Preserve quoted content. Only whitespace between SQL tokens is immaterial.
  return JSON.stringify(sql.match(token));
}

function objects(db, limit) {
  return db.prepare(`SELECT type,
    CASE WHEN length(name)<=256 THEN name ELSE '' END AS name,
    CASE WHEN length(tbl_name)<=256 THEN tbl_name ELSE '' END AS tbl_name,
    CASE WHEN sql IS NULL THEN NULL WHEN length(sql)<=? THEN sql ELSE '' END AS sql
    FROM sqlite_schema ORDER BY type,name LIMIT ?`).all(maxSql, limit);
}

function canonical(version) {
  if (expected.has(version)) return expected.get(version);
  const db = new DatabaseSync(':memory:', { allowExtension: false });
  try {
    db.exec('PRAGMA trusted_schema=OFF');
    createStateSchema(db, version);
    const schema = objects(db, 100).map(shape);
    expected.set(version, schema);
    return schema;
  } finally { db.close(); }
}

function shape(row) {
  return [row.type, row.name, row.tbl_name, normalized(row.sql)];
}

/** Validate executable schema before migrating a snapshot. Checksums are not authentication. */
export function validStateSchema(db, version) {
  if (!Number.isInteger(version) || version < 0 || version > 5) return false;
  const schema = canonical(version);
  const actual = objects(db, schema.length + 1);
  return actual.length === schema.length && actual.every((row, index) => {
    const value = shape(row);
    return value.every((field, part) => field === schema[index][part]);
  });
}
