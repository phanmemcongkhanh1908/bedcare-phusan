# Hướng dẫn Quản trị hệ thống & Phân quyền

## 1. Quản lý Khoa, Phòng, Tiêu chuẩn và Giường
- **Quản lý Khoa**: Thêm/sửa/ngừng hoạt động khoa; theo dõi công suất sử dụng từng khoa.
- **Tiêu chuẩn phòng động**: Tạo thêm tiêu chuẩn mới (ngoài 7 tiêu chuẩn mặc định) và kết hợp nhiều tiêu chuẩn cho từng phòng.
- **Bảo vệ toàn vẹn lịch sử**: Hệ thống chặn xóa phòng hoặc giảm số giường thấp hơn số giường đang có giao dịch.

## 2. Cấu hình Ngày giường & Cảnh báo
- Chọn phương pháp tính **Theo ngày lịch** hoặc **Theo số giờ thực tế**, quy tắc làm tròn (`CEIL`/`ROUND`/`FLOOR`), có tính ngày nhập viện hay không.
- Thay đổi cấu hình chỉ áp dụng cho lượt nhập mới, không tự ý sửa ngày trả của bệnh nhân đang nằm.
- Trước khi đưa bệnh viện vào sử dụng chính thức, Super Admin vào **Cấu hình hệ thống -> Xóa sạch dữ liệu demo**.

## 3. Phân quyền RBAC 5 nhóm
1. `SUPER_ADMIN`: Toàn quyền hệ thống, thiết bị, xóa demo.
2. `ADMIN`: Quản lý khoa, phòng, giường, cấu hình, sao lưu/phục hồi.
3. `CASHIER` (Thu viện phí): Đăng ký trước, giữ chỗ, tra cứu. Không được trả giường hộ khoa.
4. `WARD_STAFF` (Khoa điều trị): Chỉ thao tác tiếp nhận, gia hạn, điều chuyển, trả giường, vệ sinh trong **đúng phạm vi khoa được giao**.
5. `EXECUTIVE` (Lãnh đạo): Xem dashboard & xuất báo cáo, không sửa dữ liệu nghiệp vụ.
