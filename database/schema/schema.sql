-- BEDCARE SQLite Database Schema (Local-first P2P Architecture)
-- Version: 1.0.0

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  his_dept_code TEXT DEFAULT '',
  planned_bhyt_beds INTEGER NOT NULL DEFAULT 0,
  max_bhyt_overage_pct INTEGER NOT NULL DEFAULT 120,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_standards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('CAPACITY', 'TOILET', 'SERVICE', 'CUSTOM')),
  description TEXT DEFAULT '',
  attributes TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bed_types (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  daily_price INTEGER NOT NULL DEFAULT 0,
  hourly_price INTEGER NOT NULL DEFAULT 0,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL REFERENCES departments(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  floor TEXT DEFAULT 'Tầng 1',
  capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity >= 1),
  toilet_type TEXT NOT NULL DEFAULT 'INTERNAL' CHECK (toilet_type IN ('INTERNAL', 'EXTERNAL')),
  room_type TEXT NOT NULL DEFAULT 'STANDARD' CHECK (room_type IN ('STANDARD', 'SERVICE', 'VIP', 'ISOLATION')),
  is_service INTEGER NOT NULL DEFAULT 0,
  standard_ids TEXT NOT NULL DEFAULT '[]', -- JSON array of room_standards.id
  exclusive_locked INTEGER NOT NULL DEFAULT 0,
  exclusive_lock_id TEXT,
  occupancy_status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (occupancy_status IN ('AVAILABLE', 'PARTIAL_RESERVED', 'IN_USE', 'EXCLUSIVE')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(department_id, code)
);

CREATE TABLE IF NOT EXISTS beds (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  department_id TEXT NOT NULL REFERENCES departments(id),
  bed_type_id TEXT REFERENCES bed_types(id),
  daily_price INTEGER NOT NULL DEFAULT 0,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'VACANT' CHECK (
    status IN (
      'VACANT',
      'RESERVED',
      'OCCUPIED',
      'PENDING_CONFIRMATION',
      'PENDING_CLEANING',
      'CLEANING',
      'MAINTENANCE',
      'INACTIVE'
    )
  ),
  current_admission_id TEXT,
  current_reservation_id TEXT,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(room_id, code)
);

CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY,
  patient_code TEXT UNIQUE NOT NULL,
  his_record_code TEXT DEFAULT '',
  full_name TEXT NOT NULL,
  date_of_birth TEXT NOT NULL,
  gender TEXT DEFAULT 'Nữ',
  phone TEXT DEFAULT '',
  identity_number TEXT DEFAULT '',
  address TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS diagnosis_configs (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  default_days INTEGER NOT NULL CHECK (default_days >= 1),
  description TEXT DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS registrations (
  id TEXT PRIMARY KEY,
  registration_code TEXT UNIQUE NOT NULL,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  patient_code TEXT NOT NULL,
  his_record_code TEXT DEFAULT '',
  patient_name TEXT NOT NULL,
  date_of_birth TEXT NOT NULL,
  phone TEXT DEFAULT '',
  diagnosis_group TEXT NOT NULL,
  expected_admission_date TEXT NOT NULL,
  expected_discharge_date TEXT NOT NULL,
  desired_standard_ids TEXT NOT NULL DEFAULT '[]',
  registration_mode TEXT NOT NULL CHECK (registration_mode IN ('UNKNOWN_DEPT', 'KNOWN_DEPT')),
  department_id TEXT REFERENCES departments(id),
  room_id TEXT REFERENCES rooms(id),
  bed_id TEXT REFERENCES beds(id),
  reservation_type TEXT NOT NULL DEFAULT 'NONE' CHECK (reservation_type IN ('NONE', 'WAITLIST', 'SINGLE_BED', 'WHOLE_ROOM')),
  status TEXT NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING', 'RESERVED', 'PENDING_CONFIRMATION', 'ADMITTED', 'CANCELLED', 'EXPIRED')),
  notes TEXT DEFAULT '',
  created_by TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  registration_id TEXT REFERENCES registrations(id),
  patient_id TEXT NOT NULL REFERENCES patients(id),
  patient_name TEXT NOT NULL,
  department_id TEXT NOT NULL REFERENCES departments(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  bed_id TEXT REFERENCES beds(id), -- NULL when is_whole_room = 1
  is_whole_room INTEGER NOT NULL DEFAULT 0,
  locked_bed_ids TEXT NOT NULL DEFAULT '[]',
  start_time TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PENDING_CONFIRMATION', 'CONVERTED', 'CANCELLED', 'EXPIRED')),
  notes TEXT DEFAULT '',
  created_by TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admissions (
  id TEXT PRIMARY KEY,
  admission_code TEXT UNIQUE NOT NULL,
  registration_id TEXT REFERENCES registrations(id),
  reservation_id TEXT REFERENCES reservations(id),
  patient_id TEXT NOT NULL REFERENCES patients(id),
  patient_code TEXT NOT NULL,
  his_record_code TEXT DEFAULT '',
  patient_name TEXT NOT NULL,
  date_of_birth TEXT NOT NULL,
  phone TEXT DEFAULT '',
  diagnosis_group TEXT NOT NULL,
  department_id TEXT NOT NULL REFERENCES departments(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  bed_id TEXT NOT NULL REFERENCES beds(id),
  is_whole_room INTEGER NOT NULL DEFAULT 0,
  hospital_admitted_at TEXT NOT NULL,
  bed_assigned_at TEXT NOT NULL,
  expected_discharge_at TEXT NOT NULL,
  actual_discharge_at TEXT,
  calculation_method TEXT NOT NULL DEFAULT 'CALENDAR_DAYS',
  extension_count INTEGER NOT NULL DEFAULT 0,
  triage_priority TEXT NOT NULL DEFAULT 'NORMAL',
  vitals_alert TEXT DEFAULT '',
  medication_deadline_at TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PENDING_CONFIRMATION', 'DISCHARGED', 'TRANSFERRED')),
  notes TEXT DEFAULT '',
  confirmed_by TEXT NOT NULL,
  confirmed_by_name TEXT NOT NULL,
  discharged_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bed_extensions (
  id TEXT PRIMARY KEY,
  admission_id TEXT NOT NULL REFERENCES admissions(id),
  patient_id TEXT NOT NULL,
  patient_name TEXT NOT NULL,
  bed_id TEXT NOT NULL,
  bed_code TEXT NOT NULL,
  old_expected_discharge_at TEXT NOT NULL,
  new_expected_discharge_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  performed_by TEXT NOT NULL,
  performed_by_name TEXT NOT NULL,
  performed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bed_transfers (
  id TEXT PRIMARY KEY,
  admission_id TEXT NOT NULL REFERENCES admissions(id),
  patient_id TEXT NOT NULL,
  patient_name TEXT NOT NULL,
  from_department_id TEXT NOT NULL,
  from_room_id TEXT NOT NULL,
  from_bed_id TEXT NOT NULL,
  to_department_id TEXT NOT NULL,
  to_room_id TEXT NOT NULL,
  to_bed_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  performed_by TEXT NOT NULL,
  performed_by_name TEXT NOT NULL,
  performed_at TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS cleaning_logs (
  id TEXT PRIMARY KEY,
  bed_id TEXT NOT NULL REFERENCES beds(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  department_id TEXT NOT NULL REFERENCES departments(id),
  admission_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED')),
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  assigned_to TEXT,
  completed_by TEXT,
  completed_by_name TEXT,
  notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN', 'ADMIN', 'CASHIER', 'WARD_STAFF', 'EXECUTIVE')),
  department_id TEXT REFERENCES departments(id),
  his_permission TEXT NOT NULL DEFAULT 'NONE' CHECK (his_permission IN ('NONE', 'VIEW', 'SYNC_AND_MAP', 'FULL')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'LOCKED', 'REVOKED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  node_name TEXT NOT NULL,
  department_id TEXT,
  public_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'TRUSTED' CHECK (status IN ('TRUSTED', 'REVOKED', 'OFFLINE')),
  is_coordinator INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  paired_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  sequence_no INTEGER NOT NULL,
  lamport_clock INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 1,
  consensus_status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (consensus_status IN ('CONFIRMED', 'PENDING_QUORUM', 'REJECTED')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_queue (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  target_device_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS consensus_log (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  term INTEGER NOT NULL,
  coordinator_id TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  approving_devices TEXT NOT NULL, -- JSON array
  quorum_required INTEGER NOT NULL,
  quorum_achieved INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('COMMITTED', 'DEFERRED_NO_QUORUM', 'ABORTED_CONFLICT')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  winning_event_id TEXT,
  conflicting_event_id TEXT NOT NULL,
  winning_device_id TEXT,
  conflicting_device_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  resolution_note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS pending_requests (
  id TEXT PRIMARY KEY,
  request_type TEXT NOT NULL CHECK (request_type IN ('ASSIGN_BED', 'RESERVE_BED', 'EXCLUSIVE_ROOM')),
  target_id TEXT NOT NULL, -- bed_id or room_id
  payload TEXT NOT NULL,
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'WAITING_QUORUM' CHECK (status IN ('WAITING_QUORUM', 'COMMITTED', 'REJECTED_CONFLICT')),
  conflict_reason TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS system_configs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  device_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  backup_name TEXT NOT NULL,
  device_id TEXT NOT NULL,
  app_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 1,
  record_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILED', 'RESTORED')),
  error_message TEXT DEFAULT '',
  file_path TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS his_import_logs (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  total_rows INTEGER NOT NULL,
  imported_rows INTEGER NOT NULL,
  duplicate_rows INTEGER NOT NULL,
  error_rows INTEGER NOT NULL,
  performed_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS his_audit_resolutions (
  issue_key TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  resolution_note TEXT NOT NULL DEFAULT '',
  resolved_by TEXT NOT NULL,
  resolved_by_name TEXT NOT NULL,
  resolved_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_beds_dept_status ON beds(department_id, status);
CREATE INDEX IF NOT EXISTS idx_admissions_status ON admissions(status);
CREATE INDEX IF NOT EXISTS idx_events_lamport ON events(lamport_clock);
CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status, target_device_id);
CREATE INDEX IF NOT EXISTS idx_his_assignments_status ON his_bed_assignments(status, his_bed_code);

