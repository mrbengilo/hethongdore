# DORE · Bản chạy thử ngoài nhánh main

- Nhánh triển khai: `preview/full-website-20260808`
- Nhánh `main`: không sửa đổi trong đợt dựng preview này.
- URL chạy thử: https://hethongdore-preview-20260808.vercel.app
- Trạng thái triển khai: READY

## Tài khoản chạy thử

- Quản lý: `admin` / `dore2026`
- Nhân viên: `nv001` / `dore2026`

## Phạm vi bản chạy thử

Bản preview bao gồm giao diện và luồng quản lý cửa hàng, chi phí, nhập hàng, nhân viên, ca làm việc, đơn hàng, lương KPI, báo cáo, cổ tức và màn hình nhân viên. Quy tắc tự chuyển ca sau 60 phút được mô phỏng trong bản chạy thử.

Dữ liệu của bản preview được lưu trong `localStorage` của trình duyệt để kiểm tra nhanh, không ghi vào cơ sở dữ liệu production. Ứng dụng trong repo vẫn sử dụng kiến trúc backend Cloudflare D1.

Ngày tạo preview: 08/08/2026.
