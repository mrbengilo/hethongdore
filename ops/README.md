# DORE self-host runbook

Tài liệu này vận hành một tiến trình Next.js/Node.js duy nhất trên Ubuntu 24.04. Caddy nhận HTTPS cho `doregroup.io.vn`, ứng dụng chỉ lắng nghe tại `127.0.0.1:3000`, SQLite và tệp tải lên nằm ngoài các bản phát hành. Tiến trình chạy bằng system user không đăng nhập `dore`; tài khoản `deploy` chỉ xây dựng và phát hành mã.

## Cấu trúc cố định

| Thành phần | Đường dẫn |
| --- | --- |
| Bản phát hành bất biến | `/opt/dore/releases/<sha>` |
| Bản đang chạy | `/opt/dore/current` (symlink) |
| SQLite | `/var/lib/dore/dore.sqlite` |
| Tệp tải lên | `/var/lib/dore/uploads` |
| Cấu hình bí mật | `/etc/dore/dore.env` (root, mode `0600`) |
| Sao lưu | `/var/backups/dore` (root, mode `0700`) |
| Nhật ký ứng dụng | `journalctl -u dore` |
| Nhật ký truy cập | `/var/log/caddy/dore-access.log` |

Dữ liệu không nằm trong thư mục release. Các script triển khai/rollback không chạy migration reset cũ; tuy nhiên lần khởi động của mã mới có thể **bổ sung** bảng, cột, chỉ mục và marker tương thích còn thiếu. Khởi tạo này không xóa hay đưa số liệu vận hành về 0. Vì thay đổi lược đồ bổ sung vẫn có thể khiến mã cũ không đọc được dữ liệu mới, luôn tạo và kiểm tra backup trước khi triển khai hoặc rollback.

## 1. Chuẩn bị máy chủ một lần

Điều kiện:

- Ubuntu 24.04, tài khoản hệ điều hành `deploy` và quyền `sudo` phù hợp. Script cài đặt tạo system user `dore` idempotent.
- Node.js 22 tại `/usr/local/bin/node`, Corepack, Git, curl, sqlite3, Caddy và rsync.
- DNS `A` của `doregroup.io.vn` trỏ tới VPS; `www` là CNAME về tên miền chính.
- Firewall cho phép SSH, TCP 80 và TCP 443. Không mở cổng 3000.

Sau khi chép repo lên VPS:

```bash
cd /path/to/dore
sudo ops/scripts/install-host.sh
sudo /usr/local/lib/dore/set-manager-password.mjs --username admin
```

`install-host.sh` chỉ enable Caddy và chưa khởi động nó, tránh công khai trang 502 trước khi ứng dụng khỏe. Lần deploy thành công đầu tiên sẽ khởi động Caddy sau khi health nội bộ đạt yêu cầu.

Công cụ mật khẩu chỉ nhận dữ liệu từ terminal có ẩn ký tự, yêu cầu nhập lại, lưu PBKDF2-SHA256 và không in mật khẩu/hash. Nếu cơ sở dữ liệu đã tồn tại, công cụ đổi hash của tài khoản quản lý, xóa phiên đăng nhập quản lý cũ và ghi audit. Nếu chưa có cơ sở dữ liệu, hash chỉ được lưu để bootstrap lần đầu.

Kiểm tra cấu hình trước khi triển khai:

```bash
sudo systemd-analyze verify /etc/systemd/system/dore.service
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl status dore-backup.timer --no-pager
```

## 2. Triển khai một release

Chạy bằng tài khoản `deploy`, không chạy script này trực tiếp bằng root:

```bash
cd /path/to/dore
ops/scripts/deploy.sh --release <git-or-content-sha>
```

Sau khi build và kiểm tra trước phát hành, `deploy.sh` bắt buộc tự tạo đúng một backup nhất quán của SQLite cùng uploads ngay trước khi đổi release. Script in đường dẫn archive và dừng mà không đổi release nếu backup thất bại. Bản sao này là điểm khôi phục dữ liệu nếu ứng dụng mới bổ sung lược đồ nhưng cần quay lại mã cũ.

`<git-or-content-sha>` phải là 7-64 ký tự hex thường. Nếu bỏ `--release`, script lấy Git HEAD và từ chối source chưa commit. Script sẽ:

1. cài đúng lockfile và chạy `build:selfhost`;
2. xác minh `.next/standalone/server.js`, static và public;
3. tạo release mới, không ghi đè release đã có;
4. đổi symlink `/opt/dore/current` nguyên tử;
5. khởi động lại dịch vụ và gọi `/api/health`;
6. tự quay lại release trước nếu health check thất bại.

Release lỗi được giữ lại để kiểm tra; script không tự xóa lịch sử release.

Kiểm tra sau triển khai:

```bash
curl --fail http://127.0.0.1:3000/api/health
curl --fail https://doregroup.io.vn/api/health
sudo systemctl status dore caddy --no-pager
sudo journalctl -u dore -n 100 --no-pager
```

## 3. Rollback mã ứng dụng

Liệt kê release và chuyển về một SHA đã kiểm tra:

```bash
sudo ls -1 /opt/dore/releases
sudo /usr/local/lib/dore/rollback.sh --release <sha>
```

`rollback.sh` khôi phục và kiểm tra `Caddyfile` của release đích, rồi kiểm tra cả health nội bộ lẫn HTTPS công khai. Rollback không tự khôi phục database từ backup; trước khi rollback độc lập, hãy xác nhận còn archive do lần deploy gần nhất tạo ra (hoặc chạy `backup.sh` thủ công). Nếu release đích không khỏe, script trả lại cả release và cấu hình Caddy ban đầu.

## 4. Sao lưu

Timer mặc định chạy hằng ngày lúc khoảng 02:15 theo giờ Việt Nam:

```bash
systemctl list-timers dore-backup.timer
sudo systemctl start dore-backup.service
sudo journalctl -u dore-backup.service -n 50 --no-pager
```

Chạy thủ công:

```bash
sudo /usr/local/lib/dore/backup.sh
```

Script tạm dừng dịch vụ ứng dụng trong thời gian ngắn để chụp nhất quán SQLite bằng lệnh `.backup` cùng toàn bộ uploads, sau đó khởi động lại dịch vụ ngay. Script tiếp tục chạy `PRAGMA quick_check`, tạo checksum rồi mới công bố archive bằng rename. File môi trường và mật khẩu không nằm trong archive. Không có xóa backup tự động; áp dụng chính sách lưu giữ ngoài máy chủ sau khi đã kiểm tra bản sao từ xa.

Tối thiểu mỗi tháng, chép một archive sang nơi lưu khác và thử khôi phục trên máy thử nghiệm.

## 5. Khôi phục dữ liệu

Khôi phục thay thế toàn bộ SQLite và uploads, vì vậy bắt buộc dùng cờ xác nhận rõ ràng:

```bash
sudo /usr/local/lib/dore/restore.sh \
  --confirm-restore /var/backups/dore/dore-backup-YYYYMMDDTHHMMSSZ.tar.gz
```

Trước khi thay dữ liệu, script dừng ứng dụng và tạo thêm một backup. Nó từ chối archive có đường dẫn thoát, link hoặc tệp đặc biệt; sau đó kiểm tra checksum, SQLite và health của ứng dụng. Nếu health thất bại, trạng thái trước khôi phục được trả lại. Mật khẩu quản lý sau khôi phục là mật khẩu có trong database của archive; có thể đặt lại an toàn bằng công cụ ở mục 1.

## 6. Đổi mật khẩu quản lý khẩn cấp

```bash
sudo /usr/local/lib/dore/set-manager-password.mjs --username admin
sudo systemctl restart dore
```

Không truyền mật khẩu qua tham số, pipe, biến môi trường, lịch sử shell hoặc ticket hỗ trợ. Công cụ yêu cầu tối thiểu 12 ký tự, chỉ đổi đúng tài khoản được chọn và chỉ thu hồi phiên của tài khoản đó. Có thể thay `admin` bằng tên đăng nhập quản lý cụ thể. Nếu bỏ `--username`, công cụ mặc định an toàn về đúng tài khoản bootstrap `admin`; nó không bao giờ đổi hàng loạt các tài khoản quản lý hay quản trị cấp cao.

## 7. Kiểm tra và xử lý sự cố

```bash
sudo systemctl is-active dore caddy
sudo journalctl -u dore --since "15 minutes ago" --no-pager
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo sqlite3 /var/lib/dore/dore.sqlite 'PRAGMA quick_check;'
df -h / /var/lib/dore /var/backups/dore
```

- HTTP 502: kiểm tra `dore.service` và health nội bộ trước, rồi xem journal.
- TLS chưa cấp: kiểm tra A/CNAME, cổng 80/443 và journal của Caddy.
- Database locked: không chạy nhiều tiến trình ứng dụng; xác nhận chỉ có một `dore.service` và tránh thao tác SQLite ghi trực tiếp.
- Hết dung lượng: chuyển backup đã xác minh sang lưu trữ ngoài máy chủ trước khi xóa thủ công. Không xóa file `-wal`/`-shm` khi ứng dụng đang chạy.
- Release mới lỗi: dùng rollback; không sửa trực tiếp file trong `/opt/dore/releases`.

## 8. Kiểm soát an toàn định kỳ

- Cập nhật Ubuntu, Node.js 22 và Caddy theo lịch bảo trì; tạo backup trước khi nâng cấp lớn.
- Giữ SSH bằng khóa, tắt đăng nhập root/mật khẩu sau khi đã thử khóa và console cứu hộ.
- Theo dõi dung lượng, backup timer, health endpoint và chứng chỉ TLS.

## Reset dữ liệu vận hành theo yêu cầu chủ hệ thống

Chỉ dùng thao tác này khi chủ hệ thống yêu cầu xóa toàn bộ số liệu và tài khoản nhân viên. Công cụ tự tạo backup trước khi xóa, giữ nguyên cửa hàng và tài khoản quản lý, xóa ảnh CCCD nhân viên, sau đó kiểm tra lại ứng dụng. Nếu kiểm tra thất bại, công cụ tự khôi phục backup.

```bash
sudo /usr/local/lib/dore/reset-operational-data.sh --confirm-reset-all-data
```
- Hạn chế sudo của `deploy` theo các lệnh triển khai cần thiết sau khi hoàn tất cài đặt ban đầu.
- Không đưa `/etc/dore/dore.env`, database, uploads, backup hoặc khóa SSH vào Git/release.
