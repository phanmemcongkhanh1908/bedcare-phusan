-- Migration 001: Initial BEDCARE schema and default system configuration
-- Schema version: 1.0.0

INSERT OR IGNORE INTO system_configs (key, value, updated_at) VALUES
  ('schema_version', '1.0.0', datetime('now')),
  ('app_version', '1.0.0', datetime('now')),
  ('day_calculation_method', 'CALENDAR_DAYS', datetime('now')),
  ('day_start_hour', '0', datetime('now')),
  ('include_admission_day', 'true', datetime('now')),
  ('rounding_rule', 'CEIL', datetime('now')),
  ('due_soon_hours', '24', datetime('now')),
  ('reservation_hold_hours', '12', datetime('now')),
  ('reservation_warn_minutes', '120', datetime('now')),
  ('auto_backup_enabled', 'true', datetime('now')),
  ('his_api_url', '', datetime('now')),
  ('his_api_enabled', 'false', datetime('now')),
  ('demo_mode_active', 'true', datetime('now'));
