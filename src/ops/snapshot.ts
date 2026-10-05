import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { MIGRATIONS } from '../core/schema.js';
import { checkInvariants } from '../core/balance.js';

/** A snapshot is `<name>.sqlite.gz` plus `<name>.manifest.json`; the manifest lets the receiving box prove nothing was lost or altered in transit. */
export interface Manifest {
  format: 1;
  createdAt: string;
  migrations: number;
  tables: Record<string, number>;
  sqliteSha256: string;
  gzSha256: string;
  gzBytes: number;
}
export interface VerifyResult { ok: boolean; problems: string[]; info: string[]; tables: Record<string, number> }

const sha256 = (file: string) => new Promise<string>((res, rej) => {
  const h = createHash('sha256');
  createReadStream(file).on('data', (d) => h.update(d)).on('error', rej).on('end', () => res(h.digest('hex')));
});

function tableCounts(db: Database.Database): Record<string, number> {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  return Object.fromEntries(names.map((n) => [n, (db.prepare(`SELECT COUNT(*) c FROM "${n}"`).get() as { c: number }).c]));
}

/** Consistent online copy (SQLite backup API, safe while the app is writing in WAL mode), gzipped, with a manifest. */
export async function snapshot(db: Database.Database, outDir: string, name = `hk-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`): Promise<{ gz: string; manifest: string; m: Manifest }> {
  mkdirSync(outDir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'hk-snap-'));
  try {
    const raw = join(tmp, `${name}.sqlite`);
    await db.backup(raw);
    const copy = new Database(raw, { readonly: true });
    const tables = tableCounts(copy);
    const migrations = (copy.prepare('SELECT COUNT(*) c FROM _migrations').get() as { c: number }).c;
    copy.close();
    const gz = join(outDir, `${name}.sqlite.gz`);
    await pipeline(createReadStream(raw), createGzip({ level: 9 }), createWriteStream(gz));
    const m: Manifest = { format: 1, createdAt: new Date().toISOString(), migrations, tables, sqliteSha256: await sha256(raw), gzSha256: await sha256(gz), gzBytes: readFileSync(gz).length };
    const manifest = join(outDir, `${name}.manifest.json`);
    writeFileSync(manifest, JSON.stringify(m, null, 2) + '\n');
    return { gz, manifest, m };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** Read-only verification of a snapshot (`.sqlite.gz` or plain `.sqlite`). Never modifies the file or migrates it. */
export async function verifySnapshot(file: string, manifestPath?: string): Promise<VerifyResult> {
  const problems: string[] = [], info: string[] = [];
  if (!existsSync(file)) return { ok: false, problems: [`${file} not found`], info, tables: {} };
  const mp = manifestPath ?? file.replace(/\.sqlite(\.gz)?$/, '.manifest.json');
  const manifest: Manifest | undefined = existsSync(mp) ? JSON.parse(readFileSync(mp, 'utf8')) : undefined;
  if (!manifest) info.push(`no manifest at ${basename(mp)}: skipping checksum and row-count comparison`);
  const tmp = mkdtempSync(join(tmpdir(), 'hk-verify-'));
  try {
    let sqliteFile = file;
    if (file.endsWith('.gz')) {
      if (manifest && (await sha256(file)) !== manifest.gzSha256) problems.push('gz checksum differs from the manifest (corrupt or altered in transit)');
      sqliteFile = join(tmp, 'db.sqlite');
      try { await pipeline(createReadStream(file), createGunzip(), createWriteStream(sqliteFile)); }
      catch (e) { return { ok: false, problems: [...problems, `cannot decompress: ${(e as Error).message}`], info, tables: {} }; }
    }
    if (manifest && (await sha256(sqliteFile)) !== manifest.sqliteSha256) problems.push('sqlite checksum differs from the manifest');
    const db = new Database(sqliteFile, { readonly: true });
    try {
      const ic = db.pragma('integrity_check') as { integrity_check: string }[];
      if (ic.length !== 1 || ic[0].integrity_check !== 'ok') problems.push(`integrity_check: ${ic.map((r) => r.integrity_check).slice(0, 3).join('; ')}`);
      const fk = db.pragma('foreign_key_check') as unknown[];
      if (fk.length) problems.push(`${fk.length} foreign key violations`);
      const have = new Set((db.prepare('SELECT id FROM _migrations').all() as { id: number }[]).map((r) => r.id));
      const unknown = [...have].filter((i) => i >= MIGRATIONS.length);
      if (unknown.length) problems.push(`database has migrations ${unknown.join(',')} that this code does not know (deploy newer code first)`);
      const pending = MIGRATIONS.length - [...have].filter((i) => i < MIGRATIONS.length).length;
      if (pending) info.push(`${pending} migration(s) pending; they apply automatically on first start`);
      const tables = tableCounts(db);
      if (manifest) for (const [t, n] of Object.entries(manifest.tables)) if (tables[t] !== n) problems.push(`table ${t}: ${tables[t] ?? 'missing'} rows, manifest says ${n}`);
      if (!pending) problems.push(...checkInvariants(db as never).slice(0, 20));
      return { ok: problems.length === 0, problems, info, tables };
    } finally { db.close(); }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
