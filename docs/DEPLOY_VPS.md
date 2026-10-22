# Triển khai VPS — trạng thái xác minh và điều kiện phát hành

## Trạng thái ngày 22/10/2026

**BLOCKED: chưa có quyền truy cập VPS được xác minh; chưa xác định runtime, DB, đường deploy, watcher hoặc running SHA.** Đây là checklist để hoàn tất bàn giao, chưa phải một lần deploy thành công.

Khảo sát source tại `e22a6563e34ac4696dfe72671bfcbdd6defd5f48`:

- `db/index.ts` và `db/runtime.ts` dùng binding Cloudflare D1 `DB`.
- `vite.config.ts` dùng Vinext và Cloudflare Vite plugin; `worker/index.ts` là entrypoint Worker.
- `.openai/hosting.json` khai báo Sites project và binding DB, không cung cấp host/path/runtime VPS.
- `.github/workflows/ci.yml` chỉ kiểm thử; không có job deploy VPS.
- Repository chưa chứa runbook hoặc cấu hình watcher/release/backup của VPS.

Kiểm tra chỉ đọc ngày 22/10/2026, khoảng 17:35 Asia/Ho_Chi_Minh:

- Domain ứng dụng trong bằng chứng incident cùng ngày: `doregroup.io.vn`, DNS A `36.50.55.166`.
- `GET https://doregroup.io.vn/`: HTTP 200, header `Via: 1.1 Caddy` và các header Next router.
- `GET https://doregroup.io.vn/api/auth/me` không đăng nhập: HTTP 401, JSON `Chưa đăng nhập`.
- SSH `root@36.50.55.166` với khóa đang có, `BatchMode=yes`, `StrictHostKeyChecking=yes`: `Permission denied (publickey)`.

Các kết quả HTTP chỉ chứng minh endpoint đang đáp ứng; không chứng minh runtime bên trong, DB, commit hay tính năng mới đã phát hành. Không được suy ra public server đang chạy source này hoặc PostgreSQL từ header. Không dùng tài khoản demo trong README để xác minh production.

Kiểm tra SSH bổ sung xác nhận kết nối TCP 22 thành công, host key khớp `known_hosts`, server chỉ chấp nhận `publickey`. Client đã thử rõ ràng khóa ED25519 sẵn có bằng `IdentitiesOnly=yes`, nhưng server từ chối khóa cho tài khoản `root`. Không có cấu hình SSH cục bộ hay SSH agent bổ sung. Chưa có bằng chứng để kết luận lỗi cụ thể nằm ở `authorized_keys`, quyền thư mục hay policy `sshd` phía server.

Bằng chứng incident cùng ngày xác định nhà cung cấp VPS là InterData. Chủ hệ thống cần dùng Console/noVNC của đúng dịch vụ hoặc nhờ nhà cung cấp khôi phục quyền console và xác nhận tài khoản SSH hợp lệ. Chỉ chia sẻ **public key** nếu cần cấp lại quyền; không chia sẻ private key. Việc đổi/reset SSH, mật khẩu, reboot hoặc cài lại VPS không thuộc bước kiểm kê chỉ đọc này.

## Điều kiện cần bổ sung

Người vận hành cung cấp tài khoản SSH/console hợp lệ hoặc kênh deploy hiện có. Không đưa private key, mật khẩu hoặc token vào Git/PR/log. Sau khi có quyền, kiểm kê chỉ đọc:

1. Host, service/container, reverse proxy, working directory và repository thật.
2. Commit/release đang chạy, target SHA và trạng thái watcher nếu có.
3. Runtime Node/Worker/workerd/adapter thực tế; nguồn cấu hình, port nội bộ và readiness.
4. DB thật, vị trí/định danh, cơ chế kết nối, migration ledger, backup và restore.
5. Cách cấp session quản lý chỉ đọc để kiểm chứng scope sau deploy.

Nếu có watcher, phát hành qua watcher; không chạy deploy thủ công chồng lên nó. Nếu runtime VPS khác Worker/D1 của repo, dừng ở gate tương thích. Cần phương án adapter hoặc chuyển nền tảng riêng với mapping dữ liệu, kiểm thử, downtime/cutover và rollback được chủ hệ thống xác nhận. Không dựng DB rỗng, không chạy seed production, không mặc định Worker build chạy trực tiếp bằng PM2.

## Quy trình khi các điều kiện đã được xác minh

1. Chốt full merged SHA của PR đã qua CI đúng HEAD. Ghi release trước và đường rollback thực tế.
2. Dùng đúng DB production đã kiểm kê, tạo backup nhất quán trước migration bằng công cụ của DB đó. Với D1, dùng export/backup D1 của đúng database; với hệ khác phải có compatibility plan được duyệt trước.
3. Phục hồi bản backup vào môi trường cô lập; kiểm tra schema, số lượng dữ liệu và quan hệ tham chiếu, không công bố nội dung nhân sự. Chỉ có file backup chưa đủ chứng minh khả năng phục hồi.
4. Thử migration additive trên bản phục hồi; đối chiếu lịch sử orders, shift_sessions và payroll snapshot trước/sau. Thử cả DB mới và DB nâng cấp theo suite integration của PR.
5. Build và deploy đúng full merged SHA bằng quy trình đã kiểm kê; chạy migration theo đúng DB/runtime đã chứng minh. Giữ release cũ và backup; không thay schema bằng thao tác thủ công không có ledger.
6. Nếu có watcher, ghi `target == running == full merged SHA` và trạng thái `deployed`/`up-to-date`. Nếu chưa có endpoint SHA, lấy bằng chứng từ artifact/service manifest và tiến trình/container thực tế.
7. Kiểm tra health/readiness, đăng nhập/session đúng vai trò, trang quản lý, Lịch phân ca và tab Đổi ca. Đọc API đúng scope; thử truy cập ngoài scope với phương thức chỉ đọc và kiểm tra từ chối không rò dữ liệu.
8. Kiểm tra log runtime/migration mới. Đối chiếu dữ liệu production chỉ đọc. Chỉ thực hiện swap có ghi dữ liệu trên staging/DB test cô lập.

Lưu output đã loại secret cho mỗi bước. Thiếu bằng chứng nào thì ghi `BLOCKED`/`SKIPPED` cho đúng bước, không gộp local/CI với production.

## Rollback

Trigger: lỗi đăng nhập, lỗi DB/migration, sai scope, lỗi đổi ca hoặc sai dữ liệu.

- Chọn release trước theo watcher/deploy controller thực tế; không tự chuyển traffic khi chưa biết cơ chế triển khai.
- Giữ migration additive khi code cũ tương thích. Không xóa bảng lịch/audit/idempotency để rollback code.
- Không restore đè production vì có thể mất giao dịch phát sinh sau backup. Nếu lỗi dữ liệu cần phục hồi, chụp bản hiện tại, đối soát giao dịch mới và lập kế hoạch phục hồi có kiểm soát trước.
- Sau rollback xác minh lại SHA, session, read API, log và tính toàn vẹn dữ liệu; ghi riêng kết quả rollback code và phục hồi dữ liệu.

## Phân quyền lịch phân ca

`MANAGER` giữ vai trò quản trị chuỗi có sẵn; không đổi mọi `MANAGER` thành HTKD. `STORE_MANAGER` và `HTKD` chỉ được dùng API lịch phân ca trong scope được cấp. Các API quản trị cũ từ chối hai vai trò mới trước khi đọc hoặc ghi dữ liệu. Quy trình cấp/thu hồi scope và contract API được mô tả trong tài liệu đổi ca của bản phát hành; không suy ra quyền từ username/chức danh. Thay role trong DB có hiệu lực ở lần đọc session tiếp theo; role không hỗ trợ bị từ chối.

## Lưu ý rollback lịch phân ca

Migration mới additive về cấu trúc nhưng trigger chặn legacy start bỏ qua phân công thật. Nếu đã phát sinh lịch PLANNED, release rollback phải giữ adapter attendance mới; không quay về e22a656 một cách máy móc. Ưu tiên forward-fix hoặc release tương thích đã kiểm thử; không xóa lịch/trigger hay restore đè DB để làm app cũ chạy. Trước production phải diễn tập tình huống này với bản sao dữ liệu an toàn.
