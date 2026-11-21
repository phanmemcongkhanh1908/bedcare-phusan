# Tài liệu Kiến trúc Hệ thống BEDCARE

## 1. Nguyên tắc kiến trúc
- **Local-first Peer-to-Peer (P2P)**: Không có máy chủ tập trung cố định. Mỗi máy trạm chạy giao diện React + API cục bộ + cơ sở dữ liệu SQLite riêng.
- **Event-Sourced Synchronization**: Dữ liệu đồng bộ thông qua nhật ký sự kiện ký số Ed25519 bất biến (`applyEventToLocalDb`), đảm bảo tính lũy đẳng (idempotency) và không ghi đè file DB.

## 2. Giao thức Đồng thuận Chống Cấp Trùng Giường (Raft Quorum Consensus)
Đối với các giao dịch tranh chấp tài nguyên (`ADMISSION_CONFIRM`, `RESERVATION_CREATE`, `EXCLUSIVE_ROOM`, `BED_TRANSFER`):
1. Tính ngưỡng đa số: `quorum = floor(Tổng_nút_tin_cậy / 2) + 1`.
2. Kiểm tra kết nối tới nút điều phối (Leader). Nếu Leader tắt nhưng phân vùng vẫn đạt quorum, hệ thống tự động bầu Leader mới (Raft term +1).
3. Nếu không đạt quorum (mạng bị cô lập/phân vùng): **không cấp giường chính thức**, chỉ lưu `pending_requests` (`WAITING_QUORUM`) và chuyển trạng thái hiển thị sang `PENDING_CONFIRMATION`.
4. Nếu đạt quorum: khóa tuần tự theo tài nguyên (`bed:<id>` hoặc `room:<id>`), kiểm tra trạng thái thực tế trên tất cả nút trong quorum. Nếu có xung đột, từ chối ngay (`CONFLICT_DOUBLE_BOOKING`) và ghi nhận bảng `conflicts`. Tuyệt đối không dùng Last-Write-Wins.
