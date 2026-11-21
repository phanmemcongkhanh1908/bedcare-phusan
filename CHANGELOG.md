# Nhật ký thay đổi phiên bản (CHANGELOG)

## [1.0.0] - 2026-11-16
### Tính năng chính
- Hoàn thiện 21 màn hình nghiệp vụ quản lý giường bệnh & phòng bệnh bằng tiếng Việt chuẩn.
- Triển khai kiến trúc Local-first P2P trên SQLite độc lập cho từng máy trạm.
- Tích hợp động cơ đồng thuận Raft Quorum & kiểm soát tranh chấp chống cấp trùng giường.
- Xác thực `scrypt`, chữ ký số `Ed25519` trên sự kiện đồng bộ, sao lưu mã hóa `AES-256-GCM` + `SHA-256`.
- Hỗ trợ nhập danh sách bệnh nhân từ Excel/CSV (`.xlsx`, `.csv`) và xuất báo cáo Excel/PDF Unicode (`DejaVuSans`).
- Tích hợp 12 loại cảnh báo tự động và 12 báo cáo phân tích với Apache ECharts.
- Bổ sung bộ cấu hình Tauri v2 + NSIS (`src-tauri/`, `installer/bedcare.nsi`) sẵn sàng đóng gói Windows.
- Hoàn thiện bộ 25 kịch bản kiểm thử tự động (`tests/bedcare.test.ts`).
