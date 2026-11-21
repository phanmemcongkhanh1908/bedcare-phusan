# Tài liệu Kiểm thử & Nghiệm thu (25 Kịch bản Bắt buộc)

Bộ kiểm thử tự động nằm tại `tests/bedcare.test.ts`, chạy thực tế bằng `npm test` (`tsx --test tests/**/*.test.ts`).

## Danh mục 25 kịch bản kiểm thử tự động
1. Hai máy cùng cấp một giường -> chỉ 1 máy thắng, máy thứ 2 bị từ chối & ghi xung đột.
2. Năm máy cùng thao tác một giường -> chỉ 1 máy thắng, 4 máy bị từ chối.
3. Hai máy cùng bao trọn một phòng -> chỉ 1 máy thắng khóa độc quyền.
4. Máy mất kết nối trong khi giao dịch -> lưu `PENDING_CONFIRMATION`, không cấp chính thức.
5. Nút điều phối (Coordinator) bị tắt -> bầu Leader mới nếu còn quorum hoặc hoãn nếu mất quorum.
6. Mạng bị chia thành hai nhóm (Split-Brain) -> nhóm thiểu số không thể cấp giường chính thức.
7. Thiết bị kết nối lại -> đồng bộ sự kiện bù và đối chiếu yêu cầu chờ.
8. Đồng bộ dữ liệu trùng -> idempotent deduplication, không tạo bản ghi lặp.
9. Dữ liệu bị sai chữ ký -> từ chối sự kiện giả mạo & ghi nhận cảnh báo xung đột bảo mật.
10. Tài khoản không đủ quyền (VD: Thu viện phí trả giường, Lãnh đạo sửa dữ liệu) -> HTTP 403.
11. Nhân viên khoa khác sửa dữ liệu -> HTTP 403 chặn theo phạm vi khoa.
12. Gia hạn ngày giường -> cập nhật hạn trả và lưu lịch sử bất biến.
13. Trả giường -> đóng lượt nằm, chuyển giường sang `PENDING_CLEANING`, giải phóng phòng bao trọn.
14. Vệ sinh giường -> `PENDING_CLEANING` -> `CLEANING` -> `VACANT`.
15. Khôi phục bản sao lưu -> kiểm tra checksum SHA-256, giải mã AES-256-GCM và khôi phục an toàn.
16. Khôi phục thiết bị sau mất dữ liệu -> đối chiếu sự kiện mới hơn từ cụm trước khi cấp giường.
17. Nhập Excel có dữ liệu trùng -> phát hiện trùng mã BN/HIS, không gộp mù theo họ tên.
18. Thay đổi cấu hình ngày giường -> không tự ý sửa ngày trả của bệnh nhân đang nằm.
19. Hủy giữ chỗ -> giải phóng giường hoặc toàn bộ phòng đã khóa.
20. Đăng ký không biết khoa -> đưa vào danh sách chờ, không tự cấp giường vật lý.
21. Đăng ký bao trọn phòng -> khóa toàn bộ giường trong phòng, chặn đặt lẻ.
22. Bệnh nhân chuyển giường -> giường cũ chờ vệ sinh, giường mới đang sử dụng.
23. Thiết bị bị thu hồi quyền truy cập -> chặn mọi sự kiện và thao tác từ thiết bị bị thu hồi.
24. Nâng cấp phiên bản -> giữ nguyên schema/dữ liệu hiện có, kiểm tra tương thích `schema_version`.
25. Kiểm tra báo cáo -> số liệu báo cáo khớp 100% với trạng thái giao dịch trong SQLite.
