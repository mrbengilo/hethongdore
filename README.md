# Hệ thống quản lý chuỗi cửa hàng DORE

Ứng dụng vận hành chuỗi cửa hàng DORE dành cho hai vai trò **Quản lý** và **Nhân viên**. Hệ thống quản lý cửa hàng, nhân sự, ca làm, lịch phân ca, đơn hàng, nhập hàng, chi phí, bảng lương, khóa sổ, báo cáo và cổ tức trên dữ liệu D1 bền vững.

## Công nghệ

- React 19, TypeScript và Vinext.
- Cloudflare Worker-compatible runtime.
- Cloudflare D1/SQLite, Drizzle ORM và Cloudflare R2 cho ảnh CCCD.
- Cookie phiên `HttpOnly`; mật khẩu băm PBKDF2.
- Giao diện responsive với Lucide Icons và Be Vietnam Pro.

## Chức năng vận hành hiện có

1. **Ca làm liên tục:** nếu đã quá giờ kết thúc ca 60 phút mà nhân viên chưa kết ca, hệ thống tự tách ca tại đúng ranh giới lịch và chuyển sang ca kế tiếp. Đồng hồ lương tiếp tục không gián đoạn nhưng lịch sử vẫn là hai phiên ca riêng; thao tác được chống tạo trùng bằng `previous_session_id` duy nhất.
2. **Tiền tệ và thời gian:** VND hiển thị bằng dấu phẩy, ví dụ `15,000 đồng` và `12,890 đồng`. Thời gian hiển thị theo `Asia/Ho_Chi_Minh` với đồng hồ 24 giờ.
3. **Nhân viên hỗ trợ:** bảng lương nhân viên tách từng cửa hàng và từng ca, nêu rõ nhân viên chính/hỗ trợ, cửa hàng nguồn, giờ thực tế, lương hỗ trợ mỗi giờ, lương cứng, phụ cấp hỗ trợ, thực nhận và trạng thái chi.
4. **Chi phí cố định:** nút tạo luôn hiển thị tại cửa hàng hoạt động; mỗi lần lưu có ngày giờ và người cập nhật. Tổng quan cửa hàng cộng chi phí cố định vào toàn bộ chi phí thực tế.
5. **Chi lương và khóa kỳ:** quản lý lần lượt chốt lương nhân viên, chốt lương quản lý, xác nhận chi lương, xác nhận thưởng/phụ cấp, xác nhận đã chi, rồi kết sổ khóa kỳ. Mọi bước có lịch sử kiểm toán và kỳ khóa không thể sửa/xóa.
6. **Báo cáo và cổ tức:** báo cáo dùng số liệu thực theo cửa hàng/kỳ, so sánh kỳ trước, phân tích biên lợi nhuận, chiều hướng và hiệu quả. Cổ tức chỉ được chốt sau khi tất cả cửa hàng đang hoạt động đã khóa kỳ lương; lịch sử chia 60%/40% được lưu bất biến.
7. **Nhập hàng nhiều dòng:** danh sách hàng luôn sẵn để nhập và có nút thêm dòng. Mỗi dòng gồm tên, số lượng, đơn vị, cân nặng, đơn giá/kg, vận chuyển và thành tiền. Sau khi lưu thành công, phiếu được ghi lịch sử và danh sách trở về một dòng trống.
8. **Ca theo từng cửa hàng:** quản lý chỉnh được tên và khung giờ ca; cấu hình ban đầu là Ca 1 `07:00–12:00`, Ca 2 `12:00–17:00`, Ca 3 `17:00–23:00`.
9. **Hồ sơ nhân viên đầy đủ:** mã nhân viên, họ tên, SĐT, tỉnh/thành, phường/xã, đường/ấp, tuổi và ảnh CCCD; ảnh JPG/PNG/WebP tối đa 5 MB được lưu riêng trên R2.
10. **Lịch phân ca:** quản lý chọn ngày, ca và nhân viên rồi lưu; hỗ trợ xem theo ngày/tuần. Nhân viên xem lịch của chính mình trên trang chủ.
11. **Doanh thu từ ca:** doanh thu cửa hàng được tổng hợp từ tiền mặt và chuyển khoản của các ca đã hoàn thành trong kỳ.
12. **Tổng chi phí thực:** gồm chi phí cố định, chi phí phát sinh trong ca, nhập hàng, vận chuyển, lương nhân viên, lương quản lý, phụ cấp TikTok/hỗ trợ/khác, thưởng thủ công, thưởng KPI và thưởng quản lý.
13. **KPI tháng:** lợi nhuận trước thưởng hiệu quả được dùng để chọn đúng một ngưỡng KPI 3%, 5% hoặc 7% và phân bổ theo giờ thực tế. Sau khi cộng thưởng KPI và thưởng quản lý, hệ thống tính lợi nhuận cuối rồi đưa kỳ qua quy trình xác nhận chi và khóa sổ.

## Tài liệu

- [Yêu cầu hệ thống](docs/01-YEU-CAU-HE-THONG.md)
- [Đặc tả chức năng và quy trình](docs/02-DAC-TA-CHUC-NANG.md)
- [Kiến trúc, dữ liệu và bảo mật](docs/03-KIEN-TRUC-DU-LIEU-BAO-MAT.md)
- [Cài đặt, triển khai và kiểm thử](docs/04-CAI-DAT-TRIEN-KHAI-KIEM-THU.md)

## Chạy trên máy cá nhân

Yêu cầu Node.js 22.13 trở lên và pnpm.

```bash
pnpm install
pnpm dev
```

Kiểm tra trước khi bàn giao:

```bash
pnpm lint
pnpm test
```

## Cấu trúc chính

```text
app/                 Giao diện và API
app/api/             Xác thực và các API nghiệp vụ
app/components/      Portal quản lý/cửa hàng/nhân viên
db/                  Schema và lớp truy cập D1
drizzle/             Migration cơ sở dữ liệu
docs/                Yêu cầu và đặc tả hệ thống
tests/               Kiểm thử tự động
worker/              Điểm vào Cloudflare Worker
```

## Quy tắc dữ liệu quan trọng

- Mọi dữ liệu cửa hàng đều được giới hạn bằng `store_id`; cửa hàng `INACTIVE` chỉ đọc lịch sử.
- Đơn hàng nhân viên được backend tự gắn cửa hàng, nhân viên và mã phiên ca.
- Phiên ca snapshot cửa hàng, tên ca, lịch ca, ngày làm và mức lương giờ để lịch sử không đổi khi cấu hình được sửa.
- Snapshot `KPI_SUMMARY`, `PAYROLL_CLOSING` và `DIVIDEND` đã khóa không được sửa hoặc xóa qua API dữ liệu chung.
- Tiền lưu bằng số nguyên đồng; timestamp lưu UTC và được chuyển sang giờ Việt Nam khi hiển thị/tính kỳ.
