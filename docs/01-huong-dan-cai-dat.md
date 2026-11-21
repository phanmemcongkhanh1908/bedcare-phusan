# Hướng dẫn cài đặt BEDCARE

## 1. Yêu cầu hệ thống (Windows)
- Hệ điều hành: Windows 10/11 (64-bit).
- RAM tối thiểu: 4 GB (khuyến nghị 8 GB).
- Ổ cứng trống: tối thiểu 500 MB cho ứng dụng và dữ liệu SQLite cục bộ.
- Mạng nội bộ (LAN/Wi-Fi bệnh viện) để các máy BEDCARE ghép nối và đồng bộ P2P.

## 2. Cài đặt bằng bộ cài đặt `BEDCARE-SETUP.exe`
1. Tải hoặc sao chép file `BEDCARE-SETUP.exe` về máy trạm.
2. Chạy với quyền Administrator, chọn thư mục cài đặt (mặc định `C:\Program Files\BEDCARE`).
3. Trình cài đặt tự động tạo thư mục dữ liệu tại `%APPDATA%\BEDCARE\data` (gồm `backups/` và `keys/`).
4. Khi nâng cấp phiên bản mới, dữ liệu SQLite trong `%APPDATA%\BEDCARE\data` được giữ nguyên, không bị ghi đè.

## 3. Tạo bộ cài đặt từ mã nguồn (trên máy Windows)
1. Cài đặt Node.js >= 20, Rust (`rustup`), và NSIS.
2. Chạy PowerShell tại thư mục gốc dự án:
   ```powershell
   .\scripts\build-windows.ps1
   ```
3. File cài đặt xuất ra tại `deliverables\BEDCARE-SETUP.exe`.

## 4. Khởi tạo tài khoản quản trị ban đầu
Ở lần khởi chạy đầu tiên trên hệ thống mới, sử dụng tài khoản `superadmin` mặc định và đổi mật khẩu ngay trong mục **Tài khoản & Phân quyền**, sau đó xóa dữ liệu demo tại **Cấu hình hệ thống**.
