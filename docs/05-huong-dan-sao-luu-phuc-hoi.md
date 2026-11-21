# Hướng dẫn Sao lưu & Phục hồi dữ liệu

## 1. Sao lưu cục bộ (Backup)
- Mỗi máy trạm có thể tạo bản sao lưu độc lập tại **Sao lưu & Phục hồi -> Tạo bản sao lưu thủ công** (hoặc sao lưu tự động).
- File sao lưu `.bcare` được mã hóa bằng **AES-256-GCM**, gắn `app_version`, `schema_version`, `device_id` và **SHA-256 checksum** để phát hiện hư hỏng hoặc sửa đổi trái phép.

## 2. Phục hồi an toàn (Restore & Consensus Reconciliation)
BEDCARE **không bao giờ** ghi đè mù dữ liệu cũ lên giao dịch đã đồng thuận mới hơn trên mạng:
1. Kiểm tra checksum SHA-256 và giải mã AES-256-GCM.
2. Kiểm tra tính tương thích của `schema_version`.
3. Khôi phục snapshot cục bộ vào SQLite.
4. Tự động gọi `reconcileCluster()` để đối chiếu và áp dụng toàn bộ sự kiện đã đồng thuận mới hơn từ các máy ngang hàng đang trực tuyến trước khi máy phục hồi tham gia cấp giường trở lại.
