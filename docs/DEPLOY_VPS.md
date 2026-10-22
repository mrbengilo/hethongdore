# Triển khai VPS DORE

## Đã xác minh 22/10/2026
- doregroup.io.vn,36.50.55.166,Ubuntu24.04,Caddy.
- SSH deploy bằng public key đã được chủ hệ thống đồng ý; giữ key cũ, không bật rootSSH/password.
- dore.service user dore, Node22.23.2, /opt/dore/current/server.js.
- Release trước:380f28970a7ce360fa8d766526878516f74cc2bc từ agent/production-update-20260811.
- SQLite /var/lib/dore/dore.sqlite, uploads /var/lib/dore/uploads, secret env /etc/dore/dore.env. Không in secret.
- Toolset deploy/backup/rollback tại ops/scripts. Không tìm watcher trong service/timer/crontab đã kiểm kê; lần này dùng script deploy.
- Main477cca26…/PR14 khác production. Chủ hệ thống duyệt hòa giải, giữ Next.js+SQLite; không dùng Worker/D1 hoặc DB rỗng.

## Gate và quy trình
1. Review PR, local/CI đúng HEAD đạt yêu cầu, ghi full merged SHA.
2. Phục hồi backup vào thư mục VPS riêng mode700; kiểm manifestSHA256, quick_check, hash/count từng bảng. Không đưa dữ liệu nhân sự khỏi VPS.
3. Migration additive hai lần trên copy, bảng cũ không đổi. Kiểm riêng startup legacy: init có thể nâng order-code sequence bằng MAX trên orders; không gộp với migration.
4. Chạy release cũ trên copy đã migrate kiểm health/login. Health không chứng minh mọi flow rollback.
5. Source archive đúng mergedSHA, Node22/corepack; chạy dưới deploy:

```bash
bash ops/scripts/deploy.sh --release <full-merged-sha>
```

Script frozen install, build selfhost, stage immutable release, backup SQLite+uploads nhất quán trước switch (dừng service ngắn), validateCaddy, atomic symlink, restart, internal/public health. Lỗi auto rollback code/config. Giữ log/backup. Không chạy reset/restore hoặc thay env.

Sau deploy đối chiếu /opt/dore/current/RELEASE, symlink và process/service với fullSHA. Ghi CI main, deploy exit, health/readiness, read-only smoke. Kiểm schema/quick_check/log. Không tạo lịch/swap trên production. Nếu thiếu session kiểm UI thật, ghi giới hạn thay vì giả lập user hay đổi mật khẩu.

## Rollback
Giữ release trước và migration additive:

```bash
sudo /usr/local/lib/dore/rollback.sh --release 380f28970a7ce360fa8d766526878516f74cc2bc
```

Rollback code không restoreDB (có thể mất giao dịch mới). Không xóa audit/operation/grant. App cũ chưa có central deny HTKD: trước rollback phải thu hồi session HTKD; lần deploy này không cấp tài khoản HTKD. Lịch sau swap vẫn business_records nên attendance cũ đọc cùng nguồn. Editor cũ chưa hiểu assignmentIds/revision: trong rollback không sửa lịch đã đổi; ưu tiên forward-fix hoặc bản rollback giữ guard/identity mới.

Kiểm sau rollback SHA/service, health/login, readAPI, toàn vẹn dữ liệu. Startup legacy có thể cập nhật sequence, đối chiếu riêng. Bulk operational reset phải từ chối trước khi dừng service nếu có swap history/grants; không xóa lịch sử bất biến để ép reset.

Xem [ops/README.md](../ops/README.md) và [contract đổi ca](07-DOI-CA-LAM-VIEC.md).
