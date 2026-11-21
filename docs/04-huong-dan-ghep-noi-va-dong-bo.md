# Hướng dẫn Ghép nối thiết bị & Đồng bộ P2P

## 1. Ghép nối thiết bị mới
1. Super Admin / Admin mở mục **Quản lý thiết bị**.
2. Nhấn **Ghép nối thiết bị mới**, nhập tên máy trạm và khoa phụ trách.
3. Hệ thống sinh `device_id` duy nhất, cặp khóa bất đối xứng **Ed25519** (`public_key` / `private_key`) và khởi tạo SQLite độc lập cho nút mới.

## 2. Cơ chế đồng bộ ngang hàng
- Mỗi thao tác sinh một bản ghi trong bảng `events` có `event_id`, `lamport_clock`, `device_id`, `user_id` và chữ ký Ed25519.
- Nút nhận kiểm tra chữ ký bằng `public_key` và kiểm tra thiết bị không nằm trong danh sách `REVOKED`.
- Khi thiết bị ngoại tuyến hoặc mạng phân vùng, sự kiện nằm trong `sync_queue` và tự động gửi bù khi kết nối lại.

## 3. Thu hồi thiết bị
- Khi mất máy hoặc ngừng sử dụng máy trạm, Super Admin nhấn **Thu hồi** trong **Quản lý thiết bị**. Mọi sự kiện phát sinh từ máy bị thu hồi đều bị từ chối trên toàn cụm.
