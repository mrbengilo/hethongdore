# 04. Cài đặt, triển khai và kiểm thử

## 1. Yêu cầu môi trường

- Node.js 22.13 trở lên.
- pnpm theo lockfile của dự án.
- Git.
- Tài khoản Cloudflare/Sites có D1 khi triển khai production.

## 2. Cài đặt

```bash
git clone https://github.com/mrbengilo/hethongdore.git
cd hethongdore
pnpm install
```

Chạy phát triển:

```bash
pnpm dev
```

Mở URL local do Vinext hiển thị.

## 3. Cơ sở dữ liệu

- Schema nguồn: `db/schema.ts`.
- Migration theo thứ tự: `0000_dore_initial.sql`, `0001_functional_modules.sql`, `0002_shift_closing.sql`, `0003_shift_identity_and_transfers.sql`.
- Cấu hình Drizzle: `drizzle.config.ts`.
- Binding D1 logic: `DB` trong `.openai/hosting.json`.

Khi thay đổi schema:

1. Sửa `db/schema.ts`.
2. Chạy `pnpm db:generate`.
3. Review SQL migration, đặc biệt thao tác xóa/đổi kiểu dữ liệu.
4. Thử migration trên dữ liệu staging.
5. Sao lưu trước khi áp dụng production.

## 4. Kiểm thử

```bash
pnpm lint
pnpm test
```

`pnpm test` tạo bản build và chạy bộ kiểm tra HTML/quy tắc nghiệp vụ nguồn.

Kiểm tra riêng công thức KPI tại các ngưỡng:

```bash
node --test tests/payroll-formula.test.mjs
```

### Kiểm thử bắt buộc trước production

- Đăng nhập đúng/sai và khóa sau 10 lần.
- Điều hướng quản lý/nhân viên.
- CRUD cửa hàng và cô lập dữ liệu.
- Bắt đầu/kết ca.
- Đồng hồ nhân viên tiếp tục chạy sau khi vào ca; tên ca và ngày làm lấy từ snapshot thay vì mã phiên ngẫu nhiên.
- Không kết ca khi thiếu công việc, chi phí, tiền mặt hoặc chuyển khoản; doanh thu dương mà không có đơn hoàn tất đúng ca phải bị chặn ở API.
- Tạo/sửa/hủy đơn đúng ca.
- Thử truy cập chéo đơn bằng API.
- Công thức thưởng tại các ngưỡng 6.999/7.000, 14.999/15.000 và 29.999/30.000; xác nhận chỉ một tỷ lệ 3%/5%/7% được áp dụng.
- Tổng kết KPI tạo snapshot khóa duy nhất theo cửa hàng/tháng; nhân viên khác không đọc được dòng lương không thuộc mình.
- Phụ cấp TikTok không ghi trùng.
- Điều chuyển chưa hiệu lực dùng cửa hàng chính; trong kỳ dùng cửa hàng nhận; hết hạn/hủy/kết thúc tự thu hồi quyền. Ca hỗ trợ đang chạy phải giữ đúng snapshot cửa hàng và lương giờ.
- Khóa kỳ lương/cổ tức.
- Responsive trên điện thoại, tablet và desktop.
- Xuất CSV/Excel không thực thi công thức từ dữ liệu người dùng.

## 5. Build

```bash
pnpm build
```

Bản build phải tạo entrypoint Worker tương thích và không còn lỗi TypeScript/lint.

## 6. Triển khai

Ứng dụng hiện được triển khai bằng Sites và Cloudflare-compatible output. Quy trình phát hành chuẩn:

1. Chạy lint và test.
2. Commit toàn bộ mã nguồn, migration và tài liệu liên quan.
3. Đẩy nhánh và review pull request.
4. Merge vào nhánh chính sau khi kiểm tra.
5. Build đúng commit đã merge.
6. Triển khai phiên bản mới và theo dõi trạng thái.
7. Kiểm tra đăng nhập, API và dữ liệu sau phát hành.

## 7. Biến môi trường và bí mật

- Không commit token, cookie, khóa API hay mật khẩu production.
- Tệp `.env` cục bộ phải nằm trong `.gitignore`.
- Bí mật production được quản lý tại nền tảng triển khai.
- Tài khoản demo phải bị vô hiệu hóa hoặc đổi mật khẩu trước khi dùng dữ liệu thật.

## 8. Quy ước đóng góp

- Tạo nhánh tính năng từ `main`.
- Commit ngắn gọn, nêu đúng phạm vi.
- Pull request phải mô tả thay đổi, lý do, tác động và kiểm thử.
- Không merge khi lint/test thất bại.
- Mọi thay đổi công thức tài chính cần có kiểm thử và người nghiệp vụ phê duyệt.

## 9. Các luồng đã kết nối dữ liệu thực

- Quản lý cửa hàng: thêm, sửa, lưu trữ và tìm kiếm.
- Quản lý nhân viên: tạo tài khoản, sửa hồ sơ/lương giờ, đặt lại mật khẩu và lưu trữ.
- Giao việc: lưu theo cửa hàng, ngày, ca; nhân viên xem và xác nhận hoàn thành.
- Ca làm: bắt đầu/kết thúc ca, lịch sử ca và phụ cấp TikTok được lưu vào D1.
- Kết ca: backend xác minh nhiệm vụ, ba ô chi phí/tiền mặt/chuyển khoản và sự tồn tại của đơn khi doanh thu dương; kết quả được ghi thành lịch sử ca.
- Đơn hàng: tạo, xem, sửa, hủy và xuất CSV trong đúng ca hiện tại.
- Dữ liệu cửa hàng: thêm, sửa, xóa và xuất CSV cho ca làm, lịch phân ca, nhập hàng, chấm công, lương thưởng, dòng tiền và báo cáo.
- Lương quản lý: lương cố định 3.000.000 đồng/cửa hàng và thưởng 2% lợi nhuận.
- Lương thưởng nhân viên: preview KPI theo cửa hàng/tháng, phân phối đúng một ngưỡng, tổng kết thành snapshot khóa và trả kết quả riêng cho nhân viên.
- Điều chuyển nhân sự: lưu `employee_transfers`, tự kích hoạt/hết hạn, tạo cửa hàng truy cập hiệu lực, kết thúc/hủy và xuất lịch sử.
- Cổ tức: chụp số liệu, khóa kỳ và xuất lịch sử.
- Cài đặt hồ sơ: lưu bền vững và khôi phục sau khi tải lại trang.

## 10. Checklist bàn giao production

- [ ] Thay toàn bộ tài khoản/mật khẩu demo.
- [ ] Cấu hình quyền quản lý thực tế.
- [ ] Đánh giá nhu cầu chuẩn hóa các bảng mở rộng khi dữ liệu production tăng; không thay đổi snapshot lịch sử đã khóa.
- [ ] Bật sao lưu và diễn tập khôi phục D1.
- [ ] Cấu hình giám sát lỗi và cảnh báo đăng nhập bất thường.
- [ ] Xác nhận múi giờ, kỳ lương và chính sách làm tròn.
- [ ] Đối soát báo cáo từng cửa hàng với số liệu kế toán.
- [ ] Kiểm tra điều chuyển và chi phí nhân sự hỗ trợ.
- [ ] Khóa các kỳ lương/cổ tức đã chốt.
- [ ] Kiểm tra responsive và khả năng truy cập.
