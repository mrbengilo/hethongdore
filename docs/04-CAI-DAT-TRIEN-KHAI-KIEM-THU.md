# 04. Cài đặt, triển khai và kiểm thử

## 1. Yêu cầu môi trường

- Node.js 22.13 trở lên.
- pnpm theo lockfile của dự án.
- Git.
- Tài khoản Cloudflare/Sites có D1 và R2 khi triển khai production.

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
- Migration theo thứ tự: `0000_dore_initial.sql`, `0001_functional_modules.sql`, `0002_shift_closing.sql`, `0003_shift_identity_and_transfers.sql`, `0004_finance_duration.sql`, `0005_employee_profile_shift_rollover.sql`.
- Cấu hình Drizzle: `drizzle.config.ts`.
- Binding D1 logic: `DB` trong `.openai/hosting.json`.
- Binding R2 ảnh CCCD: `UPLOADS` trong `.openai/hosting.json`.

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

Kiểm tra riêng vòng đời cửa hàng, phạm vi nhân viên và quy ước dữ liệu:

```bash
node --test tests/store-lifecycle.test.mjs
```

Kiểm tra riêng rollover ca và các hợp đồng hồ sơ/nhập hàng/báo cáo/khóa sổ/migration:

```bash
node --test tests/shift-rollover.test.mjs tests/requirements-contracts.test.mjs
```

### Kiểm thử bắt buộc trước production

- Đăng nhập đúng/sai và khóa sau 10 lần.
- Điều hướng quản lý/nhân viên.
- Tạo/sửa cửa hàng, chuyển `ACTIVE/INACTIVE`; xác nhận quản lý thường bị từ chối DELETE, quản trị cấp cao chỉ xóa mềm được cửa hàng chưa từng có đơn và dữ liệu lịch sử không bị mất.
- Khi xóa cửa hàng có nhân viên đang hỗ trợ tại cửa hàng khác, xác nhận ca được đóng `STORE_DELETED`, tiền mặt/chuyển khoản khớp đơn và doanh thu/chi phí được cộng đúng một lần vào cửa hàng nhận.
- Không cho chuyển cửa hàng sang `INACTIVE` khi còn ca mở; sau khi ngưng, các API ghi nhân viên/ca/đơn/công việc/lương/điều chuyển trả lỗi nhưng API đọc lịch sử vẫn hoạt động.
- Tạo nhân viên ở từng cửa hàng và đăng nhập lại; xác nhận `employees.store_id = users.store_id` đúng cửa hàng đã chọn, không suy luận cửa hàng từ mã nhân viên/tên đăng nhập.
- Kiểm tra bắt buộc tỉnh, phường, đường/ấp, tuổi 15–100 và ảnh CCCD; từ chối tệp không phải JPG/PNG/WebP hoặc lớn hơn 5 MB, đồng thời xác nhận ảnh được đọc từ binding R2 `UPLOADS`.
- Bắt đầu/kết ca.
- Đồng hồ nhân viên tiếp tục chạy sau khi vào ca; tên ca và ngày làm lấy từ snapshot thay vì mã phiên ngẫu nhiên.
- Đặt thời điểm kiểm thử sau `scheduled_end_at + 60 phút`: ca cũ kết thúc tại ranh giới, ca mới bắt đầu cùng ranh giới, giờ lương liên tục, đơn sau ranh giới thuộc ca mới và gọi API lặp không tạo ca trùng.
- Không kết ca khi thiếu công việc, chi phí, tiền mặt hoặc chuyển khoản; doanh thu dương mà không có đơn hoàn tất đúng ca phải bị chặn ở API.
- Tạo/sửa/hủy đơn đúng ca.
- Thử truy cập chéo đơn bằng API.
- Công thức thưởng tại các ngưỡng 6,999/7,000, 14,999/15,000 và 29,999/30,000; xác nhận chỉ một tỷ lệ 3%/5%/7% được áp dụng.
- Tổng kết KPI tạo snapshot khóa duy nhất theo cửa hàng/tháng; nhân viên khác không đọc được dòng lương không thuộc mình.
- Bảng lương nhân viên hỗ trợ nêu đúng ca/cửa hàng nguồn-cửa hàng nhận, giờ thực tế, lương hỗ trợ/giờ, lương cứng, phụ cấp hỗ trợ được phân bổ, thực nhận và trạng thái chi.
- Tạo nhân viên bắt buộc nhập phụ cấp TikTok riêng (`0` hợp lệ); không có fallback mặc định toàn hệ thống. Phụ cấp không ghi trùng, ca đã bắt đầu và snapshot kỳ khóa không đổi khi sửa mức trên hồ sơ.
- Chi phí cố định setup, mặt bằng, điện, nước, wifi, rác, marketing và khác được áp dụng đúng `store_id`/kỳ; thay đổi kỳ mới không làm sai snapshot kỳ đã khóa.
- Mỗi lần lưu chi phí cố định phải tăng lịch sử cập nhật và hiển thị đủ ngày giờ 24 giờ; tổng quan cửa hàng phải cộng khoản này vào tổng tất cả chi phí.
- Tạo chi phí phát sinh ở mục Dòng tiền; xác nhận ngày/nội dung/số tiền được validate, lịch sử và CSV đúng, khoản chi được cộng vào `incidentalCosts` và bị khóa cùng kỳ KPI.
- Lập phiếu nhập 1–100 dòng; đối chiếu tiền hàng/vận chuyển do backend tính, số phiếu và thời gian lưu. Danh sách chỉ reset sau lưu thành công và giữ nguyên khi API lỗi.
- Kiểm thử số tiền lớn và phép cộng/phân bổ bằng VND `INTEGER` 64-bit, không có sai số floating-point hoặc tràn miền số nguyên an toàn ở API.
- Kiểm thử mốc 00:00, ca qua đêm và cuối tháng: timestamp lưu UTC nhưng `work_date`, bộ lọc kỳ và hiển thị đúng `Asia/Ho_Chi_Minh`.
- Điều chuyển chưa hiệu lực dùng cửa hàng chính; trong kỳ dùng cửa hàng nhận; hết hạn/hủy/kết thúc tự thu hồi quyền. Ca hỗ trợ đang chạy phải giữ đúng snapshot cửa hàng và lương giờ.
- Đi đủ sáu bước chốt lương nhân viên → chốt quản lý → xác nhận lương → xác nhận thưởng/phụ cấp → xác nhận đã chi → khóa kỳ; thử sửa/xóa snapshot phải bị chặn.
- Lưu danh sách/tỷ lệ chia lợi nhuận tổng đúng 100%, tải lại trang và xác nhận kỳ mở vẫn hiển thị cấu hình đã lưu dù chưa đủ điều kiện preview. Chỉ chốt sau khi tất cả cửa hàng `ACTIVE` đã khóa kỳ lương; lịch sử phải giữ tỷ lệ snapshot của từng kỳ và không thể chốt lại cùng kỳ.
- Đối chiếu báo cáo cửa hàng/toàn hệ thống: doanh thu từ ca đã hoàn thành, toàn bộ 12 nhóm chi phí, lợi nhuận trước thưởng hiệu quả, lợi nhuận cuối, xếp loại và chiều hướng.
- Xác nhận `15,000` hiển thị `15,000 đồng`, `12,890` hiển thị `12,890 đồng`; mọi ngày giờ giao diện theo đồng hồ 24 giờ Việt Nam.
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
- Tài khoản vận hành production phải dùng mật khẩu riêng, không dùng thông tin xác thực chia sẻ trong môi trường phát triển.

## 8. Quy ước đóng góp

- Tạo nhánh tính năng từ `main`.
- Commit ngắn gọn, nêu đúng phạm vi.
- Pull request phải mô tả thay đổi, lý do, tác động và kiểm thử.
- Không merge khi lint/test thất bại.
- Mọi thay đổi công thức tài chính cần có kiểm thử và người nghiệp vụ phê duyệt.

## 9. Các luồng đã kết nối dữ liệu thực

- Quản lý cửa hàng: thêm, sửa, chuyển `ACTIVE/INACTIVE` và tìm kiếm. Quản lý thường không xóa cửa hàng; quản trị cấp cao có nút xóa kèm xác nhận chỉ khi số đơn lịch sử bằng 0.
- Quản lý nhân viên: tạo tài khoản, lưu đầy đủ địa chỉ/tuổi/ảnh CCCD, sửa hồ sơ/lương giờ, đặt lại mật khẩu và lưu trữ.
- Giao việc: lưu theo cửa hàng, ngày, ca; nhân viên xem và xác nhận hoàn thành.
- Ca làm: cấu hình riêng theo cửa hàng, lịch ngày/tuần, bắt đầu/kết thúc, tự chuyển ca sau thời gian ân hạn 60 phút, lịch sử ca và phụ cấp TikTok được lưu vào D1.
- Kết ca: backend xác minh nhiệm vụ, ba ô chi phí/tiền mặt/chuyển khoản và sự tồn tại của đơn khi doanh thu dương; kết quả được ghi thành lịch sử ca.
- Đơn hàng: tạo, xem, sửa, hủy và xuất CSV trong đúng ca hiện tại.
- Nhập hàng: danh sách nhiều dòng luôn hiển thị, server tính tổng, lưu số phiếu/người/thời gian và reset biểu mẫu sau thành công.
- Chi phí cố định: tạo/cập nhật theo kỳ, lưu lịch sử từng lần bấm LƯU và được cộng vào tổng chi phí cửa hàng.
- Chi phí phát sinh: tạo từng khoản ở mục Dòng tiền, lưu lịch sử 24 giờ, xuất CSV và cộng chung với chi phí phát sinh từ ca.
- Dữ liệu nghiệp vụ của cửa hàng `ACTIVE`: thêm, sửa, hủy mềm khi nghiệp vụ cho phép và xuất CSV; cửa hàng `INACTIVE` chỉ đọc/xuất lịch sử.
- Lương quản lý: lương cố định 3,000,000 đồng/cửa hàng, 140 giờ quản lý/cửa hàng và thưởng từ cùng quỹ KPI 3%/5%/7% với nhân viên, chia theo tỷ trọng giờ trên kỳ đã khóa.
- Lương thưởng nhân viên: preview KPI theo cửa hàng/tháng, phân phối đúng một ngưỡng, chi tiết ca chính/hỗ trợ, sáu bước xác nhận chi và snapshot khóa.
- Điều chuyển nhân sự: lưu `employee_transfers`, tự kích hoạt/hết hạn, tạo cửa hàng truy cập hiệu lực, kết thúc/hủy và xuất lịch sử.
- Báo cáo: tổng hợp số liệu ca/chi phí thực tế, so sánh kỳ trước, phân tích chiều hướng và đánh giá hiệu quả theo cửa hàng/toàn chuỗi.
- Cổ tức: kiểm tra các kỳ lương đã khóa, xác nhận chia 60%/40%, khóa kỳ và xuất lịch sử.
- Cài đặt hồ sơ: lưu bền vững và khôi phục sau khi tải lại trang.

## 10. Checklist bàn giao production

- [ ] Thiết lập tài khoản và mật khẩu production riêng cho từng người dùng.
- [ ] Cấu hình quyền quản lý thực tế.
- [ ] Đánh giá nhu cầu chuẩn hóa các bảng mở rộng khi dữ liệu production tăng; không thay đổi snapshot lịch sử đã khóa.
- [ ] Bật sao lưu và diễn tập khôi phục D1.
- [ ] Cấu hình giám sát lỗi và cảnh báo đăng nhập bất thường.
- [ ] Xác nhận múi giờ, kỳ lương và chính sách làm tròn.
- [ ] Xác nhận timestamp lưu UTC, hiển thị/tính kỳ theo `Asia/Ho_Chi_Minh` và ca qua nửa đêm có `work_date` đúng.
- [ ] Đối soát toàn bộ cột tiền là VND `INTEGER` 64-bit; không có `REAL/float` trong đường tính tài chính.
- [ ] Đối soát báo cáo từng cửa hàng với số liệu kế toán.
- [ ] Đối soát cấu hình chi phí cố định và marketing riêng theo từng cửa hàng/kỳ.
- [ ] Cấu hình và kiểm tra quyền truy cập bucket R2 `UPLOADS` cho ảnh CCCD.
- [ ] Xác nhận không có thao tác xóa cửa hàng và tài khoản nhân viên mới luôn gắn đúng cửa hàng đã chọn.
- [ ] Kiểm tra điều chuyển và chi phí nhân sự hỗ trợ.
- [ ] Diễn tập rollover ca sau 60 phút và xác nhận chỉ sinh một ca kế tiếp.
- [ ] Khóa các kỳ lương/cổ tức đã chốt.
- [ ] Kiểm tra responsive và khả năng truy cập.
