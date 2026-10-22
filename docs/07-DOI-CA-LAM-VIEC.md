# 07. Lịch phân ca và đổi ca

## Quyền và thao tác

`MANAGER` là quyền quản trị toàn chuỗi đã tồn tại trong repo. Không chuyển các tài khoản này thành HTKD. Hai quyền mới `STORE_MANAGER` và `HTKD` chỉ được dùng module lịch phân ca, theo từng bản ghi `user_store_scopes`. Các API tài chính, nhân sự, đơn hàng, cửa hàng và hồ sơ cũ tiếp tục từ chối hai quyền mới. Nhân viên không được gọi API lịch/đổi ca.

Trong `/manager`, mở **Lịch phân ca**. Chọn cửa hàng và ngày, tạo định nghĩa ca (tên/giờ) rồi phân công nhân viên đang ACTIVE tại cửa hàng. Tab **Đổi ca** dùng cùng dữ liệu bền trong D1. Một ca được chọn sẵn; nhiều ca bắt buộc chọn chính xác. Form hiển thị tên/mã nhân viên, tên ca, giờ, bản xem trước và kết quả server. Đổi ngày/cửa hàng reset lựa chọn; response cũ bị bỏ qua. Kết quả chưa xác định giữ nguyên payload và idempotency key để thử lại, kể cả reload cùng tab trình duyệt.

Ví dụ: A có Ca 1 và Ca 3, B có Ca 2. Chọn Ca 1 của A và Ca 2 của B → A có Ca 2 và Ca 3, B có Ca 1. Không tác động Ca 3. Hai ca sát nhau không chồng giờ. Ca kết thúc trước giờ bắt đầu được hiểu là qua đêm, tối đa dưới 24 giờ; hai mốc giờ giống nhau bị từ chối. Ngày nghiệp vụ dùng Asia/Ho_Chi_Minh (UTC+7).

Chỉ cho đổi lịch PLANNED chưa đến giờ bắt đầu, chưa liên kết chấm công, không có phiên đang hoạt động/phát sinh thực tế giao ca và không thuộc kỳ LOCKED. Kiểm tra kỳ cả hai tháng khi ca qua biên tháng. Nhân viên nghỉ, ARCHIVED hoặc đã chuyển cửa hàng bị từ chối; chưa bổ sung điều chuyển tạm vì repo chưa có nguồn quyền điều chuyển đủ tin cậy. Không dùng chức danh/tên tài khoản để suy quyền.

## Dữ liệu và semantics

- `shift_definitions`: định nghĩa giờ theo cửa hàng. Định nghĩa mới không sửa snapshot của lịch cũ.
- `shift_assignments`: ID vị trí ca ổn định, cửa hàng/ngày/định nghĩa/tên/giờ snapshot, người được phân, status/version, actor và timestamp. Không có ghi chú cá nhân trên row; lý do thuộc operation.
- Đổi ca chỉ đổi `employee_id` trên đúng hai vị trí ca, version +1; giữ vị trí, giờ, số nhân viên mỗi ca và số phân công mỗi người. Không xóa/tạo lại assignment.
- `shift_assignment_sessions`: liên kết riêng giữa lịch và phiên thực tế; không backfill lịch sử bằng tên ca.
- `shift_swaps`: request và response bền, UNIQUE(actor_id,idempotency_key), bất biến sau DONE.
- `audit_logs`: SHIFT_SWAP chứa actor ID/name/role, operation, store/day, hai assignment/person IDs, giờ và version trước/sau, lý do, thời điểm. Audit tạo/hủy lịch cũng cùng statement. Audit lịch không được cập nhật/xóa qua SQL ứng dụng.

Không sửa `employee_id`, giờ thực tế, chủ đơn, doanh thu, phụ cấp hoặc snapshot lương của `shift_sessions`/orders/payroll khi đổi lịch.

## API

Mọi API xác thực bằng session hiện tại, đọc lại role/scope từ DB; body actorId/role không được dùng. Ngoài scope trả 404 với thông báo chung, không tiết lộ bản ghi. EMPLOYEE trả 403; chưa đăng nhập 401.

| API | Body/query | Kết quả |
|---|---|---|
| GET /api/shift-assignments | date, storeId tùy chọn | stores được cấp; employees ACTIVE, definitions, assignments của đúng store/day |
| POST /api/shift-definitions | storeId,name,startTime,endTime | definition |
| POST /api/shift-assignments | storeId,date,employeeId,definitionId | assignment |
| DELETE /api/shift-assignments | storeId,assignmentId,expectedVersion | hủy mềm, version +1 |
| POST /api/shift-swaps | storeId,date,assignmentAId,assignmentBId,expectedVersionA,expectedVersionB,idempotencyKey,reason tùy chọn | operationId, hai assignments đã lưu, replayed |

Ngày phải là YYYY-MM-DD hợp lệ, giờ HH:mm, version nguyên dương, IDs/key tối đa 128 ký tự và reason tối đa 500 ký tự. Lý do mặc định luôn được lưu khi người dùng để trống.

Các mã lỗi: INVALID_INPUT/INVALID_DATE/INVALID_TIME/INVALID_VERSION (400), FORBIDDEN (403), NOT_FOUND (404), SCHEDULE_CONFLICT/OVERLAP/STARTED/LOCKED/ELIGIBILITY/NOOP và IDEMPOTENCY_CONFLICT (409). Lỗi chưa xác định/5xx giữ nguyên request để retry. Không thay key sau timeout.

## Atomicity và concurrency trên D1

Domain chèn một row `shift_swaps`. Trigger BEFORE kiểm tra scope hiện tại, cặp assignment, version và overlap trên lịch kết quả của cả hai người, loại đúng hai assignment cũ. Trigger AFTER ghi audit trước/sau, cập nhật A, kiểm `changes()=1`, cập nhật B, kiểm `changes()=1`, rồi lưu response và DONE. Tất cả nằm trong **một statement SQLite**. `RAISE(ABORT)` ở update/audit hoặc số dòng khác 1 rollback toàn statement. Không dùng interactive transaction hoặc hai PATCH client. D1 metadata changes có thể gồm trigger writes nên API hủy dùng RETURNING để xác minh CAS.

Các trigger ở assignment tạo/cập nhật/hủy kiểm eligibility, overlap tất cả ngày/cửa hàng, kỳ khóa và chấm công ngay tại write. Không có API sửa vị trí/giờ/xóa vật lý; SQL trigger từ chối thay identity/time, delete hoặc version sai. Khóa riêng endpoint không được dùng làm bảo vệ. Các write D1 tuần tự tại DB: nếu lock kỳ thắng trước thì swap bị chặn; nếu swap thắng trước thì lock thấy lịch đã đổi. Swap không thay số liệu lương nên không làm stale snapshot tài chính. Existing payroll lock implementation ngoài phạm vi được giữ nguyên.

Start ca đọc assignment đang đến giờ của nhân viên và liên kết trong cùng D1 batch với insert session/update user/audit. Link trigger đọc lại owner và giờ để chặn stale start sau swap. Legacy start gặp lịch mới đồng thời bị chặn. Phiên có mã ASG giữ cùng phiên khi overtime/qua ngày. Nhân viên chưa có lịch thật giữ start/rollover legacy; đây là compatibility có chủ đích, không thay toàn bộ chính sách overtime trong task này.

Retry cùng key/payload trả response lưu trước đó, không chạy lại swap. Cùng key khác payload bị 409; hai request khác key dùng cùng version chỉ một thắng. Idempotency lưu lâu dài, chưa có TTL hoặc công việc dọn tự động.

## Migration và cấp quyền

Migration additive: `drizzle/0001_shift_scheduling.sql`, chia bằng statement-breakpoint để giữ nguyên trigger body. `db/scheduling.ts` dùng chính SQL đó cho runtime, không duy trì bộ trigger thứ hai. Runtime giữ các additive column migrations cũ. Không sửa migration 0000. Runtime đã ngừng seed tài khoản/dữ liệu demo và ngừng reset password hash; dữ liệu hiện hữu giữ nguyên. DB mới cần được cấp tài khoản quản trị bằng quy trình vận hành; không có tài khoản/mật khẩu mặc định.

Cấp scope do operator có quyền DB thực hiện sau khi xác minh ID tài khoản/cửa hàng thật. Ví dụ SQL dưới là template, không tự chạy production:

```sql
-- Tài khoản đã tồn tại, được chủ hệ thống chỉ định là HTKD (hoặc STORE_MANAGER).
UPDATE users SET role='HTKD' WHERE id='<verified-user-id>';
INSERT INTO user_store_scopes(user_id,store_id) VALUES('<verified-user-id>','<verified-store-id>');
DELETE FROM sessions WHERE user_id='<verified-user-id>';
-- Thu hồi một cửa hàng:
DELETE FROM user_store_scopes WHERE user_id='<verified-user-id>' AND store_id='<verified-store-id>';
```

Ghi lại người cấp quyền, lý do và trước/sau trong audit vận hành; chạy grant/revoke cùng batch. Không đổi quyền MANAGER hàng loạt. Đăng nhập lại kiểm `/api/auth/me`, scoped GET và thử trực tiếp API ngoài scope. Tests fixture chứng minh grant/revoke và deny module khác; không thử bằng dữ liệu production.

## Kiểm thử và phát hành

`pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm test`. Integration chạy Miniflare/workerd D1; E2E dùng DB test riêng và các API thật. Test source cũ chỉ là regression bổ sung, không thay transaction test. CI chạy các suite mới và build cuối. Xem test cases trong tests và báo cáo evidence của lần chạy, không coi danh sách lệnh này là bằng chứng PASS.

Triển khai VPS và rollback theo [DEPLOY_VPS.md](DEPLOY_VPS.md). Không coi Worker build là runtime Node/VPS. Phải xác minh runtime/DB, backup + restore rehearsal, merged/running SHA và watcher trước khi triển khai. Chỉ kiểm tra đọc trên production; thao tác đổi ca ghi dữ liệu chỉ chạy DB cô lập. Giữ schema additive khi rollback app; không restore đè production làm mất giao dịch mới.

### Giới hạn rollback ứng dụng

Schema là additive nhưng bản app trước tính năng không hiểu assignment. Khi đã có lịch thật, trigger cố ý chặn legacy start bỏ qua lịch. Vì vậy không rollback mù về e22a656: phải dùng release tương thích giữ adapter bắt đầu ca theo assignment và safety triggers, hoặc forward-fix. Chỉ có thể quay về app cũ sau khi kiểm chứng dữ liệu không có phân công còn hiệu lực; không xóa lịch để ép rollback. Runbook phải ghi rõ điều kiện này trước khi phát hành thực tế.

Tham khảo runtime: [Cloudflare D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) và [SQLite RAISE trong trigger](https://www.sqlite.org/lang_createtrigger.html#the_raise_function). Các kiểm thử fault injection trong repo kiểm chứng cơ chế thực thi, không chỉ dựa trên tài liệu.
