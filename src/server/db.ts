import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_PATH = path.resolve(process.cwd(), 'database/schema/schema.sql');
const MIGRATION_001_PATH = path.resolve(process.cwd(), 'database/migrations/001_initial.sql');

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function openNodeDatabase(dbFilePath: string): DatabaseSync {
  if (dbFilePath !== ':memory:') {
    const dir = path.dirname(dbFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  const db = new DatabaseSync(dbFilePath);
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schemaSql);
  const migrationSql = fs.readFileSync(MIGRATION_001_PATH, 'utf8');
  db.exec(migrationSql);

  ensureColumn(db, 'room_standards', 'attributes', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'rooms', 'occupancy_status', "TEXT NOT NULL DEFAULT 'AVAILABLE'");
  ensureColumn(db, 'beds', 'bed_type_id', 'TEXT');
  ensureColumn(db, 'beds', 'daily_price', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'admissions', 'triage_priority', "TEXT NOT NULL DEFAULT 'NORMAL'");
  ensureColumn(db, 'admissions', 'vitals_alert', "TEXT DEFAULT ''");
  ensureColumn(db, 'admissions', 'medication_deadline_at', 'TEXT');
  ensureColumn(db, 'departments', 'his_dept_code', "TEXT DEFAULT ''");
  ensureColumn(db, 'departments', 'planned_bhyt_beds', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'departments', 'max_bhyt_overage_pct', 'INTEGER NOT NULL DEFAULT 120');
  ensureColumn(db, 'users', 'his_permission', "TEXT NOT NULL DEFAULT 'NONE'");

  db.exec(`
    CREATE TABLE IF NOT EXISTS transfer_requests (
      id TEXT PRIMARY KEY,
      admission_id TEXT NOT NULL REFERENCES admissions(id),
      patient_id TEXT NOT NULL REFERENCES patients(id),
      patient_name TEXT NOT NULL,
      from_department_id TEXT NOT NULL REFERENCES departments(id),
      from_room_id TEXT NOT NULL REFERENCES rooms(id),
      from_bed_id TEXT NOT NULL REFERENCES beds(id),
      to_department_id TEXT NOT NULL REFERENCES departments(id),
      to_room_id TEXT NOT NULL REFERENCES rooms(id),
      to_bed_id TEXT NOT NULL REFERENCES beds(id),
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED', 'CANCELLED')),
      requested_by TEXT NOT NULL,
      requested_by_name TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      completed_by TEXT,
      completed_by_name TEXT,
      completed_at TEXT,
      notes TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_transfer_requests_status ON transfer_requests(status, requested_at);

    CREATE TABLE IF NOT EXISTS his_bed_mappings (
      bed_id TEXT PRIMARY KEY REFERENCES beds(id),
      his_dept_code TEXT NOT NULL DEFAULT '',
      his_room_code TEXT NOT NULL DEFAULT '',
      his_bed_code TEXT NOT NULL DEFAULT '',
      his_bed_type_code TEXT NOT NULL DEFAULT 'H2',
      bhyt_max_daily_price INTEGER NOT NULL DEFAULT 0,
      allow_shared_bed INTEGER NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS his_bed_assignments (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      his_assignment_id TEXT NOT NULL,
      his_record_code TEXT NOT NULL,
      patient_code TEXT NOT NULL,
      patient_name TEXT NOT NULL,
      date_of_birth TEXT DEFAULT '1990-01-01',
      bhyt_card_no TEXT DEFAULT '',
      his_dept_code TEXT NOT NULL,
      his_room_code TEXT DEFAULT '',
      his_bed_code TEXT NOT NULL,
      his_bed_type_code TEXT DEFAULT 'H2',
      bed_ratio REAL NOT NULL DEFAULT 1.0,
      bed_days_billed REAL NOT NULL DEFAULT 1.0,
      admitted_at TEXT NOT NULL,
      discharged_at TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISCHARGED')),
      source_system TEXT DEFAULT 'HIS_API',
      synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_his_assignments_status ON his_bed_assignments(status, his_bed_code);

    CREATE TABLE IF NOT EXISTS his_audit_resolutions (
      issue_key TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      resolution_note TEXT NOT NULL DEFAULT '',
      resolved_by TEXT NOT NULL,
      resolved_by_name TEXT NOT NULL,
      resolved_at TEXT NOT NULL
    );
  `);

  return db;
}

export function getConfigMap(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM system_configs').all() as Array<{
    key: string;
    value: string;
  }>;
  const map: Record<string, string> = {};
  for (const r of rows) {
    map[r.key] = r.value;
  }
  return map;
}
