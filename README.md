# Hệ thống quản lý chuỗi cửa hàng DORE

Ứng dụng quản lý vận hành chuỗi cửa hàng DORE dành cho hai vai trò **Quản lý** và **Nhân viên**. Hệ thống bao gồm quản lý cửa hàng, nhân sự, ca làm, chấm công, đơn hàng, dòng tiền, lương thưởng, báo cáo, điều chuyển nhân sự và cổ tức.

## Bản chạy thực tế

- Website: <https://dore-store-management.mrbengilo-76.chatgpt.site>
- Quản lý thử nghiệm: `admin` / `dore2026`
- Nhân viên thử nghiệm: `nv001` / `dore2026`

> Tài khoản trên chỉ dùng cho môi trường trình diễn. Khi triển khai chính thức phải thay mật khẩu, tắt dữ liệu mẫu và cấu hình chính sách sao lưu.

## Công nghệ

- React 19, TypeScript và Vinext.
- Cloudflare Worker-compatible runtime.
- Cloudflare D1/SQLite và Drizzle ORM.
- Cookie phiên `HttpOnly`; mật khẩu băm PBKDF2, không lưu mật khẩu thuần.
- Lucide Icons và font Be Vietnam Pro.
- Giao diện responsive cho máy tính, máy tính bảng và điện thoại.

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
app/api/             Đăng nhập, cửa hàng, ca làm và đơn hàng
app/components/      Portal quản lý/cửa hàng/nhân viên
db/                  Schema và lớp truy cập D1
drizzle/             Migration cơ sở dữ liệu
docs/                Yêu cầu và đặc tả hệ thống
tests/               Kiểm thử tự động
worker/              Điểm vào Cloudflare Worker
```

## Quy tắc nghiệp vụ nổi bật

- Quản lý xem toàn hệ thống và truy cập không gian quản trị độc lập của từng cửa hàng.
- Nhân viên chỉ xem dữ liệu cửa hàng trực thuộc và ca đang hoạt động.
- Đơn hàng nhân viên được backend tự gắn cửa hàng, nhân viên và mã ca.
- Nhân viên không thể xem, sửa hoặc hủy đơn của ca khác hay người khác.
- Nhân viên chỉ được kết ca sau khi hoàn thành công việc, nhập chi phí và doanh thu; nếu doanh thu lớn hơn 0 thì ca phải có ít nhất một đơn hàng hoàn tất.
- Mỗi phiên làm việc lưu snapshot tên ca, ngày làm việc, cửa hàng chịu chi phí và mức lương giờ áp dụng để lịch sử không thay đổi khi cấu hình được sửa sau này.
- Thưởng KPI nhân viên chỉ được ghi nhận khi quản lý tổng kết và khóa tháng; hệ thống áp dụng một ngưỡng 3%, 5% hoặc 7%, không cộng dồn.
- Điều chuyển nhân sự được lưu thành lịch sử riêng; quyền cửa hàng hỗ trợ chỉ có hiệu lực trong thời gian được duyệt và tự trở về cửa hàng chính khi hết hạn.
- Lương quản lý cố định 3.000.000 đồng/cửa hàng/tháng; thưởng quản lý bằng 2% lợi nhuận dương của cửa hàng.
- Phụ cấp TikTok được ghi nhận theo từng ca khi nhân viên xác nhận có làm clip.
- Lợi nhuận và báo cáo được tách độc lập theo cửa hàng trước khi cộng dồn toàn hệ thống.

## Trạng thái sản phẩm

Đây là bản ứng dụng vận hành có đăng nhập, phân quyền, D1 và các luồng lưu dữ liệu cho cửa hàng, nhân sự, giao việc, ca làm, đơn hàng, lương thưởng, điều chuyển, báo cáo và cổ tức. Trước khi dùng dữ liệu thật vẫn phải hoàn thành checklist production, thay tài khoản demo, cấu hình sao lưu và đối soát nghiệp vụ theo tài liệu triển khai.
