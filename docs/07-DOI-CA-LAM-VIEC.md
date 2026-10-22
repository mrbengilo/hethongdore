# Đổi ca trên lịch production

## Nền tảng
Bản tích hợp dùng nền production 380f28970a7ce360fa8d766526878516f74cc2bc: Next.js standalone, Node22, SQLite qua adapter D1-shaped. Chủ hệ thống đã duyệt hòa giải với main, giữ production và SQLite. PR14 dùng mô hình lịch riêng chưa được deploy VPS, được thay bằng thiết kế này.

Nguồn lịch thật vẫn là business_records category LICH_PHAN_CA, data_json.employeeIds và daily_shift_definitions. Không backfill lịch sử. Giữ module tài chính/lương/chấm công và lineage shift_sessions.source_schedule_record_id/source_schedule_updated_at.

## Sử dụng và quyền
Quản lý mở **Cửa hàng → chọn cửa hàng → Lịch phân ca → Đổi ca**, chọn ngày, hai nhân viên và đúng ca. Một assignment được chọn tự động; nhiều assignment bắt buộc chọn rõ. Preview trước/sau. A có sáng+tối, B có chiều: đổi sáng/chiều giữ nguyên ca tối.

MANAGER giữ scope production: có store_id thì chỉ cửa hàng đó; superadmin hoặc manager không gắn cửa hàng có scope toàn chuỗi. HTKD chỉ module /scheduling theo schedule_store_grants. API quản trị cũ từ chối HTKD tập trung tại getSessionUser. EMPLOYEE không được đổi ca. Không cấp role/grant production trong deployment.

Ngày UTC+7, khoảng ca [start,end), cho phép hai ca sát nhau. End nhỏ hơn start là qua đêm; hai mốc bằng nhau không hợp lệ. Overlap kiểm xuyên ngày/cửa hàng. Nhân viên điều chuyển phải hợp lệ tại cửa hàng và ca đích theo chính sách attendance.

Chỉ đổi lịch ACTIVE, cửa hàng/nhân viên ACTIVE, chưa bắt đầu/chấm công, kỳ chưa chốt/khóa. Qua tháng kiểm cả kỳ có thời gian thực sự thuộc ca. Không sửa người chấm công, chủ đơn, giờ thực tế, doanh thu hoặc snapshot lương.

## API
| API | Input | Output |
|---|---|---|
| GET /api/shift-swaps?stores=1 | Session | actorId, stores được cấp |
| GET /api/shift-swaps?storeId=…&date=YYYY-MM-DD | Store/day | actorId, employees, assignments, serverTime |
| POST /api/shift-swaps | storeId,date,assignmentAId,assignmentBId,expectedVersionA,expectedVersionB,idempotencyKey,reason,expectedActorId | ok,operationId,idempotent,hai assignments |

Assignment gồm id,recordId,employeeId,shiftName,start,end,startAt,endAt,workDate,version,eligible,blockedReason. Version SHA256 của JSON lịch+updated_at, dùng nguyên giá trị server. Actor lấy từ session và quyền hiện tại; expectedActorId chỉ assertion chống đổi tài khoản lúc form đang mở.

Reason chuẩn hóa 5–500 ký tự; UI cung cấp mặc định khi trống. Key16–200 ký tự chữ/số/:_-. Input400, chưa đăng nhập401, sai quyền403, stale/overlap/locked/started/idempotency mismatch409. Lỗi ghi chưa rõ500 giữ request.

UI lưu nguyên payload/key trong sessionStorage theo actor/store/day trước khi gửi. Mất phản hồi/reload không dựng request đảo chiều. Retry cùng key/payload trả kết quả lưu, khác payload bị từ chối. Đổi store/day reset form, response cũ không ghi đè scope mới; thành công reload lịch hiện hữu.

## Identity và transaction
Legacy assignment ID đọc bằng recordId:index, không rewrite dữ liệu. Khi sửa, data_json.assignmentIds lưu ID thuộc vị trí; swap giữ ID và chỉ đổi hai employeeIds/employeeNames. Generic edit giữ ID của người còn lại, UUID cho vị trí thêm. PATCH/DELETE lịch yêu cầu expectedUpdatedAt; timestamp tăng đơn điệu chống stale editor.

shift_swap_operations có UNIQUE(actor_id,request_key), payload_hash, before/after, result_json, trạng thái COMPLETED. Một INSERT là transaction boundary. Trigger kiểm lại scope/version/eligibility/overlap/attendance/period sau write lock, update A/B, kiểm changes()=1 từng bước, audit, hoàn tất operation. ABORT hoặc IGNORE thiếu bước rollback toàn statement. Không dùng hai PATCH client.

Audit SWAP_SCHEDULE ghi actor/store/operation, JSON trước/sau, record/slot/date/reason/time. Operation COMPLETED và audit swap không được update/delete. Replay bền không có TTL tự xóa. Generic schedule-write guard chặn overlap, sửa lịch bắt đầu/chấm công/khóa kỳ. Attendance production kiểm record+updated_at+employee khi start: xác nhận trước swap bị stale, người nhận đọc lịch mới.

## Migration và cấp quyền
Migration additive drizzle/0037_shift_swaps.sql, runtime db/shift-swap.ts gọi từ initDb. Hai bảng mới và trigger; không chuyển/xóa dữ liệu cũ. Kiểm fresh/upgraded schema, chạy hai lần và preservation backup thực.

Cấp HTKD là thao tác quản trị riêng sau xác minh user/store, ghi audit vận hành; không thuộc deployment. Trong một transaction đổi role user được chỉ định thành HTKD, thêm schedule_store_grants(user_id,store_id), xóa sessions của user đó. Không đổi hàng loạt MANAGER. Thu hồi DELETE grant; API/trigger kiểm quyền hiện tại.

## Kiểm chứng
- pnpm test: hồi quy production finance/payroll/attendance/auth/ops.
- pnpm test:production-shift-swap: SQLite native, real routes, fault injection, hai connection, TOCTOU, replay, scope, attendance, migration.
- pnpm verify:selfhost: Next standalone build+typecheck.
- pnpm test:e2e:selfhost: Chromium trên standalone với DB fixture, API thật; build trước.
- pnpm lint.

Fixture chỉ dùng test; không business writes production. Tách local/CI/rehearsal/deploy/production trong báo cáo. Xem [DEPLOY_VPS.md](DEPLOY_VPS.md).
