export type BedStatus =
  | 'VACANT'
  | 'RESERVED'
  | 'OCCUPIED'
  | 'PENDING_CONFIRMATION'
  | 'PENDING_CLEANING'
  | 'CLEANING'
  | 'MAINTENANCE'
  | 'INACTIVE';

export type UserRole =
  | 'SUPER_ADMIN'
  | 'ADMIN'
  | 'CASHIER'
  | 'WARD_STAFF'
  | 'EXECUTIVE';

export type HisPermissionLevel = 'NONE' | 'VIEW' | 'SYNC_AND_MAP' | 'FULL';

export type DayCalculationMethod = 'CALENDAR_DAYS' | 'ACTUAL_HOURS';
export type RoundingRule = 'CEIL' | 'FLOOR' | 'ROUND';

export interface Department {
  id: string;
  code: string;
  name: string;
  description: string;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: string;
  updated_at: string;
  // Computed metrics
  total_rooms?: number;
  total_beds?: number;
  occupied_beds?: number;
  vacant_beds?: number;
  reserved_beds?: number;
  cleaning_beds?: number;
  maintenance_beds?: number;
  occupancy_rate?: number;
  his_dept_code?: string;
  planned_bhyt_beds?: number;
  max_bhyt_overage_pct?: number;
}

export interface RoomStandardAttributes {
  has_ac?: boolean;
  has_tv?: boolean;
  has_fan?: boolean;
  has_guest_chair?: boolean;
  toilet_type?: 'INTERNAL' | 'EXTERNAL_SHARED' | 'NONE';
}

export interface RoomStandard {
  id: string;
  name: string;
  code: string;
  category: 'CAPACITY' | 'TOILET' | 'SERVICE' | 'CUSTOM';
  description: string;
  attributes?: RoomStandardAttributes;
  is_default: number;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: string;
}

export interface BedType {
  id: string;
  code: string;
  name: string;
  daily_price: number;
  hourly_price: number;
  description: string;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: string;
  updated_at: string;
}

export interface Room {
  id: string;
  department_id: string;
  department_name?: string;
  code: string;
  name: string;
  floor: string;
  capacity: number;
  toilet_type: 'INTERNAL' | 'EXTERNAL';
  room_type: 'STANDARD' | 'SERVICE' | 'VIP' | 'ISOLATION';
  is_service: number;
  standard_ids: string[];
  exclusive_locked: number;
  exclusive_lock_id?: string | null;
  occupancy_status?: 'AVAILABLE' | 'PARTIAL_RESERVED' | 'IN_USE' | 'EXCLUSIVE';
  status: 'ACTIVE' | 'INACTIVE';
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface Bed {
  id: string;
  room_id: string;
  room_code?: string;
  room_name?: string;
  floor?: string;
  department_id: string;
  department_name?: string;
  code: string;
  name: string;
  status: BedStatus;
  current_admission_id?: string | null;
  current_reservation_id?: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
  patient_name?: string;
  patient_code?: string;
  his_record_code?: string;
  date_of_birth?: string;
  admission_code?: string;
  diagnosis_group?: string;
  confirmed_by_name?: string;
  bed_assigned_at?: string;
  hospital_admitted_at?: string;
  expected_discharge_at?: string;
  admission_notes?: string;
  is_whole_room?: number;
  care_team?: string[];
  bed_type_id?: string | null;
  bed_type_name?: string | null;
  bed_type_code?: string | null;
  daily_price?: number;
  hourly_price?: number;
  room_type?: 'STANDARD' | 'SERVICE' | 'VIP' | 'ISOLATION';
  standard_ids?: string[];
  cleaning_log_id?: string | null;
  room_occupancy_status?: 'AVAILABLE' | 'PARTIAL_RESERVED' | 'IN_USE' | 'EXCLUSIVE';
  exclusive_locked?: boolean;
  exclusive_holder_name?: string | null;
  reservation_patient_name?: string | null;
  reservation_expires_at?: string | null;
  is_exclusive_companion?: boolean;
}

export interface BedHistoryEntry {
  id: string;
  admission_code: string;
  patient_code: string;
  his_record_code: string;
  patient_name: string;
  date_of_birth: string;
  diagnosis_group: string;
  department_name: string;
  room_name: string;
  bed_code: string;
  bed_assigned_at: string;
  expected_discharge_at: string;
  actual_discharge_at?: string | null;
  status: 'ACTIVE' | 'PENDING_CONFIRMATION' | 'DISCHARGED' | 'TRANSFERRED';
  extension_count: number;
  confirmed_by_name: string;
  notes: string;
  days_stayed: number;
  relation_type: 'DIRECT' | 'TRANSFERRED_OUT' | 'TRANSFERRED_IN';
  transfer_note?: string;
}

export interface DiagnosisConfig {
  id: string;
  name: string;
  default_days: number;
  description: string;
  is_active: number;
  updated_at: string;
}

export interface Registration {
  id: string;
  registration_code: string;
  patient_id: string;
  patient_code: string;
  his_record_code: string;
  patient_name: string;
  date_of_birth: string;
  phone: string;
  diagnosis_group: string;
  expected_admission_date: string;
  expected_discharge_date: string;
  desired_standard_ids: string[];
  registration_mode: 'UNKNOWN_DEPT' | 'KNOWN_DEPT';
  department_id?: string | null;
  department_name?: string;
  room_id?: string | null;
  room_name?: string;
  bed_id?: string | null;
  bed_code?: string;
  reservation_type: 'NONE' | 'WAITLIST' | 'SINGLE_BED' | 'WHOLE_ROOM';
  status: 'WAITING' | 'RESERVED' | 'PENDING_CONFIRMATION' | 'ADMITTED' | 'CANCELLED' | 'EXPIRED';
  notes: string;
  created_by: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
}

export interface Reservation {
  id: string;
  registration_id?: string | null;
  patient_id: string;
  patient_name: string;
  department_id: string;
  department_name?: string;
  room_id: string;
  room_name?: string;
  bed_id?: string | null;
  bed_code?: string;
  is_whole_room: number;
  locked_bed_ids: string[];
  start_time: string;
  expires_at: string;
  status: 'ACTIVE' | 'PENDING_CONFIRMATION' | 'CONVERTED' | 'CANCELLED' | 'EXPIRED';
  notes: string;
  created_by: string;
  created_by_name: string;
  created_at: string;
}

export interface VitalPoint {
  timeLabel: string;
  recordedAt: string;
  heartRate: number;
  systolicBp: number;
  diastolicBp: number;
  spo2: number;
  temperature: number;
}

export interface Vitals24hSummary {
  points: VitalPoint[];
  latestHeartRate: number;
  latestSystolicBp: number;
  latestDiastolicBp: number;
  latestSpo2: number;
  latestTemp: number;
  hrDelta: number;
  bpDelta: number;
  clinicalStatus: 'CRITICAL' | 'WARNING' | 'STABLE';
  clinicalNote: string;
}

export interface Admission {
  id: string;
  admission_code: string;
  registration_id?: string | null;
  reservation_id?: string | null;
  patient_id: string;
  patient_code: string;
  his_record_code: string;
  patient_name: string;
  date_of_birth: string;
  phone: string;
  diagnosis_group: string;
  department_id: string;
  department_name?: string;
  room_id: string;
  room_name?: string;
  bed_id: string;
  bed_code?: string;
  is_whole_room: number;
  hospital_admitted_at: string;
  bed_assigned_at: string;
  expected_discharge_at: string;
  actual_discharge_at?: string | null;
  calculation_method: DayCalculationMethod;
  extension_count: number;
  triage_priority?: 'CRITICAL' | 'HIGH' | 'NORMAL';
  vitals_alert?: string;
  medication_deadline_at?: string | null;
  status: 'ACTIVE' | 'PENDING_CONFIRMATION' | 'DISCHARGED' | 'TRANSFERRED';
  notes: string;
  confirmed_by: string;
  confirmed_by_name: string;
  discharged_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface BedExtension {
  id: string;
  admission_id: string;
  patient_id: string;
  patient_name: string;
  bed_id: string;
  bed_code: string;
  old_expected_discharge_at: string;
  new_expected_discharge_at: string;
  reason: string;
  performed_by: string;
  performed_by_name: string;
  performed_at: string;
}

export interface BedTransfer {
  id: string;
  admission_id: string;
  patient_id: string;
  patient_name: string;
  from_department_id: string;
  from_room_id: string;
  from_bed_id: string;
  to_department_id: string;
  to_room_id: string;
  to_bed_id: string;
  reason: string;
  performed_by: string;
  performed_by_name: string;
  performed_at: string;
}

export interface TransferRequest {
  id: string;
  admission_id: string;
  patient_id: string;
  patient_name: string;
  from_department_id: string;
  from_department_name?: string;
  from_room_id: string;
  from_room_name?: string;
  from_bed_id: string;
  from_bed_code?: string;
  to_department_id: string;
  to_department_name?: string;
  to_room_id: string;
  to_room_name?: string;
  to_bed_id: string;
  to_bed_code?: string;
  reason: string;
  status: 'PENDING' | 'COMPLETED' | 'CANCELLED';
  requested_by: string;
  requested_by_name: string;
  requested_at: string;
  completed_by?: string | null;
  completed_by_name?: string | null;
  completed_at?: string | null;
  notes: string;
  elapsed_minutes: number;
  is_delayed: boolean;
}

export interface AdmissionAuditEntry {
  id: string;
  timestamp: string;
  category: 'ADMISSION' | 'EXTENSION' | 'TRANSFER_REQUEST' | 'TRANSFER' | 'CLEANING' | 'DISCHARGE' | 'SYSTEM';
  title: string;
  detail: string;
  locationLabel: string;
  actorName: string;
}

export interface CleaningLog {
  id: string;
  bed_id: string;
  bed_code?: string;
  room_id: string;
  room_name?: string;
  department_id: string;
  department_name?: string;
  admission_id?: string | null;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';
  requested_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  assigned_to?: string | null;
  completed_by?: string | null;
  completed_by_name?: string | null;
  notes: string;
}

export interface UserAccount {
  id: string;
  username: string;
  full_name: string;
  role: UserRole;
  department_id?: string | null;
  department_name?: string;
  status: 'ACTIVE' | 'LOCKED' | 'REVOKED';
  his_permission?: HisPermissionLevel;
  is_default_admin?: boolean;
  created_at: string;
  updated_at: string;
}

export interface DeviceNode {
  device_id: string;
  node_name: string;
  department_id?: string | null;
  public_key: string;
  status: 'TRUSTED' | 'REVOKED' | 'OFFLINE';
  is_coordinator: number;
  last_seen_at: string;
  paired_at: string;
}

export interface SystemAlert {
  id: string;
  type:
    | 'BED_DUE_SOON'
    | 'BED_DUE_TODAY'
    | 'BED_OVERDUE'
    | 'RESERVATION_EXPIRING'
    | 'UNALLOCATED_REGISTRATION'
    | 'BED_PENDING_CLEANING'
    | 'BED_MAINTENANCE'
    | 'SYNC_PENDING'
    | 'DATA_CONFLICT'
    | 'DEVICE_OFFLINE'
    | 'BACKUP_FAILED'
    | 'PENDING_CONFIRMATION';
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  message: string;
  department_id?: string;
  department_name?: string;
  entity_id?: string;
  created_at: string;
}

export interface SystemConfigMap {
  schema_version: string;
  app_version: string;
  day_calculation_method: DayCalculationMethod;
  day_start_hour: string;
  include_admission_day: string;
  rounding_rule: RoundingRule;
  due_soon_hours: string;
  reservation_hold_hours: string;
  reservation_warn_minutes: string;
  auto_backup_enabled: string;
  his_api_url: string;
  his_api_enabled: string;
  his_api_token?: string;
  his_sync_mode?: string;
  demo_mode_active: string;
}

export type HisAuditCategory =
  | 'DUPLICATE_BED'
  | 'IRRATIONAL_ASSIGNMENT'
  | 'QUOTA_EXCEEDED';

export interface HisBedMapping {
  bed_id: string;
  bed_code: string;
  bed_name: string;
  bed_status: BedStatus;
  room_id: string;
  room_code: string;
  room_name: string;
  room_type: Room['room_type'];
  room_capacity: number;
  department_id: string;
  department_code: string;
  department_name: string;
  daily_price: number;
  his_dept_code: string;
  his_room_code: string;
  his_bed_code: string;
  his_bed_type_code: string;
  bhyt_max_daily_price: number;
  allow_shared_bed: number;
  notes: string;
  updated_by: string;
  updated_at: string;
}

export interface HisBedAssignment {
  id: string;
  batch_id: string;
  his_assignment_id: string;
  his_record_code: string;
  patient_code: string;
  patient_name: string;
  date_of_birth: string;
  bhyt_card_no: string;
  his_dept_code: string;
  his_room_code: string;
  his_bed_code: string;
  his_bed_type_code: string;
  bed_ratio: number;
  bed_days_billed: number;
  admitted_at: string;
  discharged_at: string | null;
  status: 'ACTIVE' | 'DISCHARGED';
  source_system: string;
  synced_at: string;
}

export interface HisAuditIssue {
  issue_key: string;
  category: HisAuditCategory;
  rule_code: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  title: string;
  description: string;
  bhyt_regulation_ref: string;
  department_id?: string | null;
  department_name?: string;
  room_id?: string | null;
  room_name?: string;
  bed_id?: string | null;
  bed_code?: string;
  his_bed_code?: string;
  his_dept_code?: string;
  his_record_code?: string;
  patient_name?: string;
  his_summary?: string;
  bedcare_summary?: string;
  can_auto_admit?: boolean;
  can_quick_map?: boolean;
  resolved: boolean;
  resolution_note?: string;
  resolved_by_name?: string;
  resolved_at?: string;
}

export interface HisDepartmentQuotaRow {
  department_id: string;
  department_code: string;
  department_name: string;
  his_dept_code: string;
  planned_bhyt_beds: number;
  max_bhyt_overage_pct: number;
  physical_beds: number;
  bedcare_occupied_beds: number;
  his_active_patients: number;
  his_effective_bed_units: number;
  quota_utilization_pct: number;
  status: 'COMPLIANT' | 'OVER_PLANNED' | 'CRITICAL_OVERAGE';
}

export interface HisAuditSummary {
  total_his_active: number;
  total_bedcare_occupied: number;
  mapped_beds_count: number;
  total_beds_count: number;
  open_issues_count: number;
  duplicate_count: number;
  irrational_count: number;
  quota_exceeded_count: number;
  resolved_count: number;
  last_synced_at: string | null;
  last_source: string | null;
}

export interface HisAuditReport {
  summary: HisAuditSummary;
  issues: HisAuditIssue[];
  departmentQuotas: HisDepartmentQuotaRow[];
  mappings: HisBedMapping[];
  assignments: HisBedAssignment[];
  importLogs: Array<Record<string, unknown>>;
}

