# 03. Kiến trúc, dữ liệu và bảo mật

## 1. Kiến trúc hiện tại

```text
Trình duyệt
  └─ React/Vinext UI
       └─ API routes chạy trên Cloudflare Worker
            ├─ Xác thực và phân quyền
            ├─ Nghiệp vụ cửa hàng/ca/đơn/tài chính
            ├─ Cloudflare D1 (SQLite)
            └─ Cloudflare R2 (ảnh CCCD)
```

Ứng dụng dùng một codebase TypeScript cho giao diện và API. D1 là nguồn dữ liệu bền; Drizzle mô tả schema và migration nằm trong `drizzle/`.

## 2. Bảng dữ liệu đã triển khai

### `stores`

Thông tin cửa hàng, địa chỉ, các bộ đếm tương thích cũ, trạng thái và ngày tạo. Báo cáo hiện tại không đọc bộ đếm doanh thu/chi phí này mà tổng hợp theo kỳ từ ca và bản ghi nghiệp vụ. Trạng thái vận hành gồm `ACTIVE` và `INACTIVE`; `DELETED` là tombstone kết thúc chỉ quản trị cấp cao có thể tạo khi cửa hàng chưa từng có đơn. Cửa hàng không bị xóa vật lý hoặc chuyển sang `ARCHIVED`; toàn bộ khóa và quan hệ lịch sử được giữ nguyên.

### `employees`

Nhân viên, cửa hàng chính, mã nhân viên, chức vụ, SĐT, tỉnh, phường, đường/ấp, tuổi, khóa/tên ảnh CCCD, lương giờ và trạng thái. `employees.store_id` là cửa hàng chính. Ảnh thật nằm trong R2 `UPLOADS`; D1 chỉ giữ `cccd_image_key` và `cccd_image_name`.

### `users`

Tài khoản đăng nhập, hash mật khẩu, vai trò, liên kết nhân viên/cửa hàng, bộ đếm đăng nhập sai và trạng thái ca hiện tại. Với tài khoản nhân viên, `users.store_id` phải bằng `employees.store_id`; tạo/chuyển cửa hàng chính cập nhật hai bản ghi trong cùng một giao dịch. Mã nhân viên hoặc tên đăng nhập không được dùng để suy luận cửa hàng.

### `sessions`

Phiên đăng nhập với token đã băm, thời hạn và ngày tạo.

### `orders`

Mã đơn, cửa hàng, nhân viên, ca, khách hàng tùy chọn, số tiền, thanh toán, trạng thái và thời gian tạo.

### `business_records`

Kho dữ liệu nghiệp vụ có phân loại cho định nghĩa ca, giao việc, lịch phân ca, phiếu nhập nhiều dòng, chi phí cố định/phát sinh, khoản lương thưởng thủ công và các snapshot khóa `KPI_SUMMARY`, `PAYROLL_CLOSING`, `DIVIDEND`. Dữ liệu JSON luôn đi kèm `category`, `store_id`, chủ sở hữu, trạng thái và thời gian tạo/cập nhật. Ba loại snapshot khóa chỉ được tạo bởi endpoint chuyên biệt và không thể sửa/xóa qua `/api/records`.

### `shift_sessions`

Phiên chấm công thực tế của nhân viên. `shift_code` là khóa nghiệp vụ duy nhất liên kết đơn hàng; `shift_name` là tên ca để hiển thị và lọc. Bảng lưu `work_date`, giờ lịch dạng `HH:mm`, `scheduled_start_at`/`scheduled_end_at`, giờ thực tế, cửa hàng chịu chi phí, `transfer_id`, `applied_hourly_rate`, doanh thu, chi phí, trạng thái công việc và phụ cấp TikTok dưới dạng snapshot. Ca tự chuyển còn lưu `previous_session_id`, `close_reason` và `close_status`; phiên cũ kết thúc tại ranh giới lịch, phiên mới bắt đầu cùng thời điểm.

### `employee_transfers`

Lịch sử điều chuyển gồm nhân viên, cửa hàng đi/nhận, ngày hiệu lực, danh sách ca, lương hỗ trợ, phụ cấp, lý do, trạng thái, người tạo và thời gian kết thúc. Các trạng thái nghiệp vụ là `SCHEDULED`, `ACTIVE`, `COMPLETED` và `CANCELLED`.

### `audit_logs`

Người thao tác, hành động, loại thực thể, khóa bản ghi, chi tiết và thời gian.

## 3. Mô hình dữ liệu mở rộng dài hạn

Các luồng hiện tại đã lưu bền bằng `shift_sessions`, `employee_transfers` và `business_records`. Khi khối lượng dữ liệu tăng hoặc cần khóa ngoại/chứng từ chi tiết hơn, có thể chuẩn hóa tiếp thành các nhóm bảng sau mà không thay đổi hợp đồng nghiệp vụ:

| Nhóm | Bảng đề xuất | Mục đích |
|---|---|---|
| Ca làm | `shift_definitions`, `shift_assignments` | tách định nghĩa ca và lịch phân khỏi dữ liệu JSON; phiên thực tế tiếp tục ở `shift_sessions` |
| Công việc | `task_templates`, `shift_tasks`, `task_completions` | giao việc và trạng thái hoàn thành |
| Nhập hàng | `products`, `purchase_receipts`, `purchase_items` | mặt hàng, phiếu nhập và giá vốn |
| Dòng tiền | `cash_entries`, `expense_categories`, `fixed_cost_settings` | thu/chi, marketing và chi phí mặc định |
| Lương | `payroll_periods`, `payroll_items`, `allowances`, `bonuses` | chuẩn hóa snapshot `KPI_SUMMARY` và khoản cộng/trừ hiện lưu trong `business_records` |
| TikTok | `store_reward_settings`, `tiktok_submissions` | cấu hình và ghi nhận clip theo ca |
| Điều chuyển | `transfer_shifts`, `transfer_approvals` | chuẩn hóa danh sách ca/người duyệt bổ sung cho `employee_transfers` khi cần quy trình duyệt nhiều cấp |
| Cổ đông | `shareholders`, `ownership_periods`, `dividend_periods`, `dividend_items` | tỷ lệ theo kỳ và lịch sử cổ tức |
| Báo cáo | `period_locks`, `report_exports` | khóa kỳ và nhật ký xuất báo cáo |

Tất cả bảng nghiệp vụ theo cửa hàng phải có `store_id` hoặc trường xác định cửa hàng chịu chi phí.

### Cấu hình chi phí cố định

Ở mô hình hiện tại, cấu hình được lưu trong `business_records` với category `CHI_PHI_CO_DINH` và hợp đồng tương đương `fixed_cost_settings`:

- khóa cửa hàng và loại chi phí;
- số tiền VND dạng `INTEGER` 64-bit;
- kỳ tháng áp dụng;
- người tạo/cập nhật, `created_at`, `updated_at`, `changeHistory` theo UTC và ghi chú;
- các loại chuẩn gồm setup, mặt bằng, điện, nước, wifi, rác, marketing và khác.

Không cập nhật ngược cấu hình đã được dùng trong snapshot kỳ khóa. Khi chuẩn hóa thành bảng riêng, migration phải giữ nguyên `store_id`, kỳ hiệu lực và audit.

## 4. Chỉ mục và ràng buộc

- `orders.code` duy nhất.
- Chỉ mục đơn hàng theo `(store_id, employee_id, shift_code, created_at)`.
- Chỉ mục phiên theo `(token_hash, expires_at)`.
- Chỉ mục nhân viên theo `(store_id, status)`.
- Chỉ mục ca theo `(store_id, work_date, status)`, lịch sử nhân viên theo `(employee_id, started_at)` và tra ca mở theo `(employee_id, status, scheduled_end_at)`.
- Chỉ mục duy nhất có điều kiện trên `previous_session_id` khi khác `NULL` bảo đảm một phiên chỉ sinh một ca kế tiếp trong rollover.
- Chỉ mục điều chuyển theo `(employee_id, start_date, end_date, status)` và `(target_store_id, start_date, end_date, status)`.
- Bảng tổng kết tháng cần khóa duy nhất theo `(store_id, period)`.
- `employees.store_id` và `users.store_id` của cùng tài khoản nhân viên phải đồng nhất; nên kiểm tra bằng service giao dịch và kiểm thử hồi quy vì SQLite không hỗ trợ trực tiếp ràng buộc chéo hai bảng.
- Vòng đời vận hành chỉ cho phép `ACTIVE ↔ INACTIVE`; thao tác `ACTIVE → INACTIVE` bị từ chối khi còn `shift_sessions.status = 'ACTIVE'`. `DELETED` là trạng thái kết thúc, không được khôi phục qua PATCH.
- DELETE cửa hàng phải kiểm tra lại `NOT EXISTS orders` trong cùng batch ghi tombstone. Batch đó đóng ca còn mở bằng giờ server, đối soát doanh thu ca hỗ trợ vào cửa hàng nhận, thu hồi phiên liên quan và không xóa các bản ghi lịch sử.
- Một nhân viên chỉ có tối đa một `shift_session` đang mở tại một thời điểm; `users.current_shift` phải trỏ đúng phiên đó.
- Một ca chỉ được hưởng một phụ cấp TikTok cho mỗi nhân viên.
- Tỷ lệ cổ đông của một kỳ phải có tổng bằng 100%.

## 5. API hiện tại

| Endpoint | Phương thức | Quyền | Mục đích |
|---|---|---|---|
| `/api/auth/login` | POST | công khai | đăng nhập, khóa tạm và tạo phiên |
| `/api/auth/logout` | POST | đã đăng nhập | hủy phiên |
| `/api/auth/me` | GET | đã đăng nhập | lấy người dùng hiện tại |
| `/api/stores` | GET/POST/PATCH | quản lý | danh sách, tạo, sửa và chuyển `ACTIVE/INACTIVE` |
| `/api/stores` | DELETE | quản trị cấp cao | kiểm tra lại cửa hàng chưa từng có đơn, sau đó ghi tombstone `DELETED`, đóng ca và thu hồi truy cập trong cùng giao dịch |
| `/api/employees` | GET/POST/PATCH | quản lý | danh sách, tạo/sửa/lưu trữ hồ sơ và tài khoản nhân viên |
| `/api/uploads` | GET/POST | quản lý | tải lên và đọc ảnh CCCD riêng tư từ R2 |
| `/api/shift` | POST | nhân viên | bắt đầu/kết ca và phụ cấp TikTok |
| `/api/shift` | GET | nhân viên | đối chiếu rollover, trạng thái ca hiện tại và snapshot tên/giờ ca |
| `/api/shifts` | GET | đã đăng nhập | lịch sử ca theo quyền; trả `shiftName`, `workDate`, nhân viên và lương giờ áp dụng |
| `/api/schedule` | GET | nhân viên | lịch phân ca của chính nhân viên trong khoảng ngày |
| `/api/orders` | GET | theo vai trò | quản lý xem rộng, nhân viên xem ca hiện tại |
| `/api/orders` | POST/PATCH/DELETE | nhân viên trong ca | tạo, sửa, hủy mềm đơn của chính mình |
| `/api/payroll` | GET | theo vai trò | preview/snapshot KPI; nhân viên nhận chi tiết nguồn trả và từng ca chính/hỗ trợ của mình |
| `/api/payroll` | POST | quản lý | sáu bước chốt lương, xác nhận chi và khóa kỳ theo cửa hàng/tháng |
| `/api/transfers` | GET/POST/PATCH | quản lý | lịch sử, tạo, hủy hoặc kết thúc điều chuyển |
| `/api/records` | theo thao tác | theo vai trò/danh mục | định nghĩa ca, lịch phân, phiếu nhập, chi phí và khoản cộng thủ công |
| `/api/reports` | GET | quản lý | báo cáo cửa hàng/toàn hệ thống, kỳ trước, đánh giá và lịch sử cổ tức |
| `/api/reports` | POST | quản lý | xác nhận chia cổ tức sau khi mọi cửa hàng hoạt động đã khóa kỳ lương |

Các endpoint tuân theo cùng nguyên tắc: lấy danh tính và phạm vi cửa hàng từ phiên, validate server-side và ghi audit cho thao tác nhạy cảm.

Mọi endpoint ghi theo cửa hàng phải kiểm tra `stores.status = 'ACTIVE'` ở backend. Với cửa hàng `INACTIVE`, endpoint đọc vẫn hoạt động để phục vụ lịch sử nhưng POST/PATCH/DELETE nghiệp vụ trả lỗi xung đột; không dựa riêng vào trạng thái disabled trên giao diện.

## 6. Phân quyền

### Quản lý

- Đọc toàn chuỗi.
- Ghi cấu hình, cửa hàng, nhân viên, ca, tài chính, lương, điều chuyển và cổ tức.
- Quản lý thường không xóa cửa hàng. Quản trị cấp cao chỉ ghi tombstone có audit khi không có bất kỳ đơn hàng lịch sử nào; không xóa vật lý dữ liệu phụ thuộc.
- Mọi truy vấn chi tiết cửa hàng vẫn phải có phạm vi rõ ràng để tránh cộng nhầm.

### Nhân viên

- Phạm vi mặc định: `employee_id` và `store_id` trong phiên.
- Phạm vi ca: `shift_code` đang hoạt động và khoảng thời gian vào/ra.
- Phạm vi hỗ trợ: backend tính cửa hàng hiệu lực từ `employee_transfers` còn hạn; ca đang chạy giữ snapshot `store_id` và `transfer_id` cho đến lúc kết ca.
- Không chấp nhận trường quyền do trình duyệt tự gửi.

## 7. Bảo mật

- PBKDF2 với salt ngẫu nhiên cho mật khẩu; cân nhắc Argon2id nếu runtime chính thức hỗ trợ.
- So sánh hash theo cách hạn chế timing leak.
- Token phiên ngẫu nhiên; chỉ lưu hash token trong D1.
- Cookie `HttpOnly`, `Secure` ở production và `SameSite=Lax` hoặc chặt hơn.
- Rotate/hủy phiên khi đổi mật khẩu hoặc khóa tài khoản.
- Rate limit đăng nhập theo tài khoản và IP; khóa tạm sau 10 lần sai.
- Validate độ dài chuỗi, số tiền nguyên, tuổi nhân viên 15–100, khóa ảnh CCCD, loại/kích thước tệp và enum thanh toán.
- Encode dữ liệu xuất CSV để ngăn CSV formula injection.
- Không ghi mật khẩu, token, cookie hay dữ liệu nhạy cảm vào log.
- Hủy đơn bằng trạng thái, không xóa vật lý.
- Audit log cần bất biến ở tầng ứng dụng và có chính sách lưu trữ.

## 8. Tính toàn vẹn tài chính

- Tiền lưu bằng `INTEGER` 64-bit của SQLite/D1, đơn vị VND, không dùng số thực. API nhận số nguyên an toàn, kiểm tra miền giá trị và trả số chưa định dạng; giao diện/xuất báo cáo thêm dấu phẩy hàng nghìn và chữ `đồng`, ví dụ `15,000 đồng`.
- Tỷ lệ phần trăm và phân bổ dùng decimal hoặc phép toán số nguyên dùng chung; chỉ làm tròn một lần về đồng ở kết quả cuối. Không nhân/chia tiền bằng JavaScript floating-point rải rác trong UI/API.
- Bảng lương và cổ tức phải là snapshot theo kỳ.
- Tổng kết KPI tháng lưu một `KPI_SUMMARY` khóa theo cửa hàng/kỳ. Snapshot chứa lợi nhuận, tổng giờ, ngưỡng duy nhất đạt được, chi tiết thưởng và tổng chi trả; POST lặp lại cùng kỳ phải bị từ chối.
- Lương ca dùng `applied_hourly_rate`, không đọc ngược lương hiện tại của hồ sơ sau khi ca đã hoàn thành.
- Ca hỗ trợ được hạch toán vào `shift_sessions.store_id` của cửa hàng nhận; lương giờ/phụ cấp hỗ trợ lấy từ snapshot điều chuyển.
- Công thức dùng một module nghiệp vụ dùng chung cho UI, API, báo cáo và kiểm thử.
- Mọi báo cáo xuất file phải nhận cùng tham số lọc với truy vấn màn hình.
- Khóa kỳ sau khi xác nhận đã chi; snapshot khóa không thể sửa hoặc xóa qua API chung.

### Chuẩn thời gian

- Mọi timestamp bền vững lưu UTC dạng ISO 8601 có hậu tố `Z` hoặc epoch được định nghĩa rõ; `created_at`, `updated_at`, `started_at`, `ended_at` và audit không lưu giờ địa phương mơ hồ.
- Backend chuyển UTC sang `Asia/Ho_Chi_Minh` để xác định `work_date`, ranh giới tháng/quý/năm, lịch phân ca và điều chuyển. Khoảng lọc kỳ được đổi thành cận UTC trước khi truy vấn.
- Dữ liệu hiển thị dùng `Asia/Ho_Chi_Minh` và đồng hồ 24 giờ (`hourCycle: h23`); ca qua nửa đêm giữ `work_date` đã snapshot tại lúc bắt đầu, không suy ra lại bằng cách cắt chuỗi timestamp UTC.

## 9. Sao lưu và vận hành

- Bật sao lưu định kỳ D1 và kiểm thử phục hồi.
- Migration chỉ chạy một chiều sau khi đã review và thử trên môi trường staging.
- Theo dõi tỷ lệ lỗi API, đăng nhập thất bại, thời gian phản hồi và sai lệch báo cáo.
- Tách môi trường development, staging và production; không dùng chung dữ liệu/tài khoản.
