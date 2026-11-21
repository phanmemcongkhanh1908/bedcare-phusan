# Tài liệu Cơ sở dữ liệu SQLite

File schema chuẩn: `database/schema/schema.sql`, migration: `database/migrations/001_initial.sql`.

## Các nhóm bảng chính
1. **Cơ cấu bệnh viện**: `departments`, `room_standards`, `rooms` (có `exclusive_locked`), `beds` (8 trạng thái chuẩn).
2. **Bệnh nhân & Tiếp nhận**: `patients`, `diagnosis_configs`, `registrations` (Form A/B), `reservations` (giữ giường / bao trọn phòng), `admissions`.
3. **Vận hành nội trú**: `bed_extensions` (bất biến), `bed_transfers`, `cleaning_logs`.
4. **Bảo mật & P2P**: `users` (mật khẩu `scrypt`), `devices` (khóa `Ed25519`), `events`, `sync_queue`, `consensus_log`, `conflicts`, `pending_requests`.
5. **Quản trị & Kiểm toán**: `system_configs`, `audit_logs`, `backups`, `his_import_logs`.

## Công thức tính Công suất sử dụng giường
`Công suất (%) = (Số giường ĐANG SỬ DỤNG / Tổng giường hoạt động) * 100`
Trong đó: `Tổng giường hoạt động = Tổng giường - (Giường Bảo trì + Giường Ngừng hoạt động)`.
