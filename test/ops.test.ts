import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/core/db.js';
import { seedHousehold } from './helpers.js';
import { snapshot, verifySnapshot } from '../src/ops/snapshot.js';
import { seedDemo } from '../src/seed/demo.js';

describe('snapshot / verify (data moves between machines provably intact)', () => {
  it('round-trips a database and the verifier accepts it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hk-ops-'));
    const src = openDb(join(dir, 'src.sqlite'));
    seedDemo(src, '2026-10-05');
    const s = await snapshot(src, join(dir, 'out'), 't1');
    expect(s.m.tables.transactions).toBeGreaterThan(0);
    const r = await verifySnapshot(s.gz);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.tables.transactions).toBe(s.m.tables.transactions);
  });
  it('detects a corrupted file, a tampered row count and a missing manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hk-ops-'));
    const src = openDb(join(dir, 'src.sqlite'));
    seedDemo(src, '2026-10-05');
    const s = await snapshot(src, join(dir, 'out'), 't2');
    const buf = readFileSync(s.gz); buf[buf.length - 20] ^= 0xff;
    const bad = join(dir, 'out', 'bad.sqlite.gz'); writeFileSync(bad, buf);
    expect((await verifySnapshot(bad, s.manifest.replace('t2', 't2'))).ok).toBe(false);
    const m = JSON.parse(readFileSync(s.manifest, 'utf8')); m.tables.transactions += 1;
    const mp = join(dir, 'out', 'edited.manifest.json'); writeFileSync(mp, JSON.stringify(m));
    expect((await verifySnapshot(s.gz, mp)).problems.join()).toMatch(/gz checksum|transactions/);
    const none = await verifySnapshot(s.gz, join(dir, 'nope.json'));
    expect(none.info.join()).toMatch(/no manifest/);
    expect(none.ok).toBe(true);
  });
  it('refuses a database from newer code', async () => {
    const h = seedHousehold(openDb(join(mkdtempSync(join(tmpdir(), 'hk-ops-')), 'a.sqlite')));
    const file = (h.db as any).name as string;
    h.db.prepare("INSERT INTO _migrations(id) VALUES (999)").run();
    h.db.close();
    const r = await verifySnapshot(file);
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/newer code|do not know|does not know/);
    new Database(file).close();
  });
});
