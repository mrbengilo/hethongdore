# 03. Kiến trúc, dữ liệu và bảo mật

## 1. Kiến trúc hiện tại

```text
Trình duyệt
  └─ React/Vinext UI
       └─ API routes chạy trên Cloudflare Worker
            ├─ Xác thực và phân quyền
            ├─ Nghiệp vụ cửa hàng/ca/đơn
            └─ Cloudflare D1 (SQLite)
```

Ứng dụng dùng một codebase TypeScript cho giao diện và API. D1 là nguồn dữ liệu bền; Drizzle mô tả schema và migration nằm trong `drizzle/`.

## 2. Bảng dữ liệu đã triển khai

### `stores`

Thông tin cửa hàng, địa chỉ, doanh thu/chi phí tổng hợp, trạng thái và ngày tạo.

### `employees`

Nhân viên, cửa hàng chính, mã nhân viên, chức vụ, SĐT, lương giờ và trạng thái.

### `users`

Tài khoản đăng nhập, hash mật khẩu, vai trò, liên kết nhân viên/cửa hàng, bộ đếm đăng nhập sai và trạng thái ca hiện tại.

### `sessions`

Phiên đăng nhập với token đã băm, thời hạn và ngày tạo.

### `orders`

Mã đơn, cửa hàng, nhân viên, ca, khách hàng tùy chọn, số tiền, thanh toán, trạng thái và thời gian tạo.

### `audit_logs`

Người thao tác, hành động, loại thực thể, khóa bản ghi, chi tiết và thời gian.

## 3. Mô hình dữ liệu mục tiêu

Để hoàn thiện toàn bộ yêu cầu vận hành, cần bổ sung các nhóm bảng sau:

| Nhóm | Bảng đề xuất | Mục đích |
|---|---|---|
| Ca làm | `shift_definitions`, `shift_assignments`, `work_sessions` | định nghĩa ca, lịch phân và chấm công thực tế |
| Công việc | `task_templates`, `shift_tasks`, `task_completions` | giao việc và trạng thái hoàn thành |
| Nhập hàng | `products`, `purchase_receipts`, `purchase_items` | mặt hàng, phiếu nhập và giá vốn |
| Dòng tiền | `cash_entries`, `expense_categories`, `fixed_cost_settings` | thu/chi, marketing và chi phí mặc định |
| Lương | `payroll_periods`, `payroll_items`, `allowances`, `bonuses` | snapshot bảng lương và khoản cộng/trừ |
| TikTok | `store_reward_settings`, `tiktok_submissions` | cấu hình và ghi nhận clip theo ca |
| Điều chuyển | `staff_transfers`, `transfer_shifts`, `transfer_approvals` | thời gian, ca, duyệt và quyền hỗ trợ |
| Cổ đông | `shareholders`, `ownership_periods`, `dividend_periods`, `dividend_items` | tỷ lệ theo kỳ và lịch sử cổ tức |
| Báo cáo | `period_locks`, `report_exports` | khóa kỳ và nhật ký xuất báo cáo |

Tất cả bảng nghiệp vụ theo cửa hàng phải có `store_id` hoặc trường xác định cửa hàng chịu chi phí.

## 4. Chỉ mục và ràng buộc

- `orders.code` duy nhất.
- Chỉ mục đơn hàng theo `(store_id, employee_id, shift_code, created_at)`.
- Chỉ mục phiên theo `(token_hash, expires_at)`.
- Chỉ mục nhân viên theo `(store_id, status)`.
- Bảng tổng kết tháng cần khóa duy nhất theo `(store_id, period)`.
- Một nhân viên chỉ có tối đa một `work_session` đang mở tại một thời điểm.
- Một ca chỉ được hưởng một phụ cấp TikTok cho mỗi nhân viên.
- Tỷ lệ cổ đông của một kỳ phải có tổng bằng 100%.

## 5. API hiện tại

| Endpoint | Phương thức | Quyền | Mục đích |
|---|---|---|---|
| `/api/auth/login` | POST | công khai | đăng nhập, khóa tạm và tạo phiên |
| `/api/auth/logout` | POST | đã đăng nhập | hủy phiên |
| `/api/auth/me` | GET | đã đăng nhập | lấy người dùng hiện tại |
| `/api/stores` | GET/POST/PATCH/DELETE | quản lý | danh sách và CRUD cửa hàng |
| `/api/shift` | POST | nhân viên | bắt đầu/kết ca và phụ cấp TikTok |
| `/api/orders` | GET | theo vai trò | quản lý xem rộng, nhân viên xem ca hiện tại |
| `/api/orders` | POST/PATCH/DELETE | nhân viên trong ca | tạo, sửa, hủy mềm đơn của chính mình |

API mới nên theo cùng nguyên tắc: lấy danh tính và phạm vi cửa hàng từ phiên, validate server-side và ghi audit cho thao tác nhạy cảm.

## 6. Phân quyền

### Quản lý

- Đọc toàn chuỗi.
- Ghi cấu hình, cửa hàng, nhân viên, ca, tài chính, lương, điều chuyển và cổ tức.
- Mọi truy vấn chi tiết cửa hàng vẫn phải có phạm vi rõ ràng để tránh cộng nhầm.

### Nhân viên

- Phạm vi mặc định: `employee_id` và `store_id` trong phiên.
- Phạm vi ca: `shift_code` đang hoạt động và khoảng thời gian vào/ra.
- Phạm vi hỗ trợ: quyền tạm thời đã duyệt, đúng cửa hàng, ngày và ca.
- Không chấp nhận trường quyền do trình duyệt tự gửi.

## 7. Bảo mật

- PBKDF2 với salt ngẫu nhiên cho mật khẩu; cân nhắc Argon2id nếu runtime chính thức hỗ trợ.
- So sánh hash theo cách hạn chế timing leak.
- Token phiên ngẫu nhiên; chỉ lưu hash token trong D1.
- Cookie `HttpOnly`, `Secure` ở production và `SameSite=Lax` hoặc chặt hơn.
- Rotate/hủy phiên khi đổi mật khẩu hoặc khóa tài khoản.
- Rate limit đăng nhập theo tài khoản và IP; khóa tạm sau 10 lần sai.
- Validate độ dài chuỗi, số tiền nguyên dương, tuổi 1–120 và enum thanh toán.
- Encode dữ liệu xuất CSV để ngăn CSV formula injection.
- Không ghi mật khẩu, token, cookie hay dữ liệu nhạy cảm vào log.
- Hủy đơn bằng trạng thái, không xóa vật lý.
- Audit log cần bất biến ở tầng ứng dụng và có chính sách lưu trữ.

## 8. Tính toàn vẹn tài chính

- Tiền lưu bằng số nguyên VND, không dùng số thực.
- Bảng lương và cổ tức phải là snapshot theo kỳ.
- Công thức dùng một module nghiệp vụ dùng chung cho UI, API, báo cáo và kiểm thử.
- Mọi báo cáo xuất file phải nhận cùng tham số lọc với truy vấn màn hình.
- Khóa kỳ sau tổng kết; điều chỉnh qua nghiệp vụ mở khóa có kiểm soát.

## 9. Sao lưu và vận hành

- Bật sao lưu định kỳ D1 và kiểm thử phục hồi.
- Migration chỉ chạy một chiều sau khi đã review và thử trên môi trường staging.
- Theo dõi tỷ lệ lỗi API, đăng nhập thất bại, thời gian phản hồi và sai lệch báo cáo.
- Tách môi trường development, staging và production; không dùng chung dữ liệu/tài khoản.

