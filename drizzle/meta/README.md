# Metadata migration

`0000_dore_initial.sql` là migration cũ được giữ nguyên. `_journal.json` trước bản đổi ca chưa có entries; bản này ghi lại tên/order hai migration để công cụ nhận diện, không tuyên bố hai migration đã chạy trên production.

`0001_snapshot.json` được tạo bằng `generateSQLiteDrizzleJson` của `drizzle-kit` từ schema hiện tại. Đây là baseline khai báo sau migration 0001 **và** phần reconciliation schema legacy của `db/runtime.ts`: năm cột hồ sơ nhân viên cùng các index runtime đã tồn tại trước tính năng đổi ca. Không backfill lịch sử bằng dữ liệu demo. Các trigger nghiệp vụ vẫn nằm trong SQL migration viết tay; Drizzle snapshot không thay thế chúng.

Không chạy lại migration 0000 trên DB đã có bảng. Khi triển khai, kiểm kê migration ledger thực tế; DB legacy đã được runtime khởi tạo chỉ áp dụng phần mới 0001 và reconciliation legacy kiểm tra tên cột trước khi ALTER. DB mới chạy 0000, 0001 và reconciliation legacy trước khi phục vụ request. Backup và thử restore/migration cô lập phải hoàn tất trước production.

Sau khi thay schema khai báo có thể chạy `pnpm db:generate`; review SQL trước khi áp dụng. Với bản này, `pnpm exec drizzle-kit generate --name verify_no_schema_drift` trả `No schema changes, nothing to migrate`. Những lần thay đổi trigger phải có migration SQL mới; không sửa trigger production bằng cách thay nội dung migration đã phát hành.
