# BEDCARE — Phần mềm Quản lý Giường bệnh & Phòng bệnh Toàn diện

BEDCARE là hệ thống quản lý giường bệnh, phòng bệnh, tiếp nhận nội trú và điều phối công suất bệnh viện theo kiến trúc **Local-first Peer-to-Peer (P2P)**, không phụ thuộc máy chủ tập trung cố định.

## Đặc điểm kỹ thuật cốt lõi
- **Cơ sở dữ liệu cục bộ SQLite** độc lập trên từng máy trạm (`WAL` mode + khóa ngoại).
- **Đồng bộ sự kiện ký số Ed25519**: Mỗi thay đổi nghiệp vụ là một sự kiện bất biến, có `event_id`, `lamport_clock`, `device_id`, `user_id` và chữ ký số Ed25519.
- **Đồng thuận phân tán Raft Quorum**: Mọi thao tác cấp giường, giữ chỗ, bao trọn phòng hoặc điều chuyển đều kiểm tra trạng thái mới nhất trên đa số nút tin cậy. Tuyệt đối **không dùng Last-Write-Wins** để ghi đè giường đã cấp.
- **Chế độ phân vùng / mất mạng**: Khi không đủ quorum, máy trạm chỉ ghi nhận yêu cầu `PENDING_CONFIRMATION` (Chờ xác nhận) và tự động đối chiếu khi mạng khôi phục.
- **Bảo mật & Sao lưu**: Băm mật khẩu `scrypt`, phân quyền RBAC 5 vai trò + phạm vi khoa, sao lưu mã hóa `AES-256-GCM` kèm `SHA-256` checksum.

## Chạy nhanh trong môi trường phát triển
```bash
npm install
npm run dev
```
Truy cập `http://localhost:3000`.

## Tài khoản mẫu (chế độ Demo)
- Super Admin: `superadmin` / `Bedcare@2026`
- Admin: `admin` / `Admin@2026`
- Thu viện phí: `thuvienphi` / `Vienphi@2026`
- Khoa Sản A: `khoasana` / `Khoasan@2026`
- Lãnh đạo: `lanhdao` / `Lanhdao@2026`

## Đóng gói ứng dụng Windows (`BEDCARE-SETUP.exe`)
Chạy `scripts/build-windows.ps1` trên máy Windows có cài đặt Rust, Tauri CLI v2 và NSIS.
