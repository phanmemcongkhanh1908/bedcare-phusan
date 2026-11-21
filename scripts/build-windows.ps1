# Script đóng gói bộ cài đặt Windows BEDCARE-SETUP.exe trên máy Windows 10/11
# Yêu cầu: Node.js >= 20, Rust toolchain (rustup), Tauri CLI v2, NSIS

$ErrorActionPreference = "Stop"
Write-Host "1. Cài đặt thư viện Node.js..." -ForegroundColor Cyan
npm ci

Write-Host "2. Kiểm tra mã nguồn & chạy bộ kiểm thử tự động..." -ForegroundColor Cyan
npm run lint
npm test

Write-Host "3. Build giao diện Production..." -ForegroundColor Cyan
npm run build

Write-Host "4. Build ứng dụng Desktop Tauri & Tạo BEDCARE-SETUP.exe..." -ForegroundColor Cyan
npx tauri build --bundles nsis

$nsisOut = Get-ChildItem -Path "src-tauri\target\release\bundle\nsis" -Filter "*.exe" | Select-Object -First 1
if ($nsisOut) {
  New-Item -ItemType Directory -Force -Path "deliverables" | Out-Null
  Copy-Item $nsisOut.FullName "deliverables\BEDCARE-SETUP.exe" -Force
  Write-Host "Hoàn tất! Bộ cài đặt tại: deliverables\BEDCARE-SETUP.exe" -ForegroundColor Green
}
