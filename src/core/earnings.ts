import { audit, type DB } from './db.js';

/** Earnings scenarios (design §12.5): net = salary × work time × (1 − tax rate); rates in basis points to stay integer. */
export interface Line { person?: string | null; label: string; annualSalaryCents: number; workTimeBp?: number; taxRateBp: number; recurring?: boolean }

export function lineNetAnnual(l: Pick<Line, 'annualSalaryCents' | 'workTimeBp' | 'taxRateBp'>): number {
  const gross = Math.round((l.annualSalaryCents * (l.workTimeBp ?? 10000)) / 10000);
  return Math.round((gross * (10000 - l.taxRateBp)) / 10000);
}
export function lineMetrics(l: Line) {
  const gross = Math.round((l.annualSalaryCents * (l.workTimeBp ?? 10000)) / 10000);
  const net = lineNetAnnual(l);
  return { grossAnnual: gross, netAnnual: net, monthlyGross: Math.round(gross / 12), monthlyNet: Math.round(net / 12), biWeekly: Math.round(net / 26) };
}

export function createScenario(db: DB, name: string, lines: Line[], notes?: string): number {
  return db.transaction(() => {
    const id = Number(db.prepare('INSERT INTO earning_scenarios(name, notes) VALUES (?,?)').run(name, notes ?? null).lastInsertRowid);
    setScenarioLines(db, id, lines);
    return id;
  })();
}
export function setScenarioLines(db: DB, id: number, lines: Line[]): void {
  db.prepare('DELETE FROM earning_scenario_lines WHERE scenario_id=?').run(id);
  const ins = db.prepare('INSERT INTO earning_scenario_lines(scenario_id, person, label, annual_salary_cents, work_time_bp, tax_rate_bp, recurring) VALUES (?,?,?,?,?,?,?)');
  for (const l of lines) ins.run(id, l.person ?? null, l.label, l.annualSalaryCents, l.workTimeBp ?? 10000, l.taxRateBp, l.recurring === false ? 0 : 1);
  db.prepare('UPDATE earning_scenarios SET version=version+1 WHERE id=?').run(id);
}
export function cloneScenario(db: DB, id: number, name: string): number {
  const lines = scenarioLines(db, id);
  return createScenario(db, name, lines);
}
export function scenarioLines(db: DB, id: number): Line[] {
  return (db.prepare('SELECT * FROM earning_scenario_lines WHERE scenario_id=? ORDER BY id').all(id) as any[]).map((r) => ({ person: r.person, label: r.label, annualSalaryCents: r.annual_salary_cents, workTimeBp: r.work_time_bp, taxRateBp: r.tax_rate_bp, recurring: !!r.recurring }));
}
/** Scenario monthly net = sum of recurring lines; one-time lines (bonus) are shown but excluded. */
export function scenarioMonthlyNet(db: DB, id: number): number {
  const net = scenarioLines(db, id).filter((l) => l.recurring !== false).reduce((a, l) => a + lineNetAnnual(l), 0);
  return Math.round(net / 12);
}
export function suggestScenarioName(lines: Line[]): string {
  return lines.filter((l) => l.recurring !== false).map((l) => `${l.person ?? l.label} $${Math.round(l.annualSalaryCents / 100000)}k @ ${l.taxRateBp / 100}%`).join(' + ');
}
export { audit };
