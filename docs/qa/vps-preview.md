# Kiểm tra trên trình duyệt của người vận hành qua SSH

Dùng khi trình duyệt kiểm thử từ xa không kết nối được. Đây là bước kiểm tra giao diện trước khi merge, không thay thế bằng kết quả build hoặc kiểm thử API.

## Mở bản kiểm thử riêng

Trên Windows PowerShell của máy đã đăng nhập được tài khoản `deploy`, chạy lệnh dưới đây sau khi thay `<SHA_CI_DA_DAT>` bằng commit đầy đủ đã đạt CI của PR:

```powershell
ssh -t -o ExitOnForwardFailure=yes -L 127.0.0.1:13001:127.0.0.1:13001 deploy@36.50.55.166 "git clone --no-checkout https://github.com/mrbengilo/hethongdore.git dore-preview-<SHA_CI_DA_DAT> && cd dore-preview-<SHA_CI_DA_DAT> && git checkout --detach <SHA_CI_DA_DAT> && bash ops/scripts/preview-release.sh"
```

Lệnh tải đúng commit, tạo SQLite mới trong `/tmp/dore-preview-*`, tạo dữ liệu mẫu, tự kiểm tra ví dụ chia lợi nhuận, build và chạy trên `127.0.0.1:13001`. SSH chỉ chuyển cổng về máy đang thao tác. Không mở cổng firewall, không đọc database/uploads/mật khẩu production, không đổi Caddy hoặc bản đang chạy. Không dùng đường dẫn clone này cho lần chạy thứ hai; thư mục đã tồn tại thì Git tự dừng để tránh ghi đè.

Khi terminal báo ứng dụng đã sẵn sàng, mở **http://localhost:13001** trên chính máy Windows đó. Giữ cửa sổ SSH mở. Tài khoản và mật khẩu thử được in sau khi build:

| Tài khoản | Phạm vi |
| --- | --- |
| `qa-admin` | Toàn bộ giao diện admin và các cửa hàng |
| `qa-manager` | Cửa hàng B, để kiểm tra quyền và nhập lương quản lý |
| `qa-employee` | Trang nhân viên cửa hàng B |

Đây là dữ liệu mẫu riêng; thao tác lưu/chốt trên địa chỉ localhost chỉ tác động vào bản thử. Mật khẩu mới được tạo ngẫu nhiên cho mỗi lần khởi tạo; không có phiên đăng nhập được cài sẵn.

## Kiểm tra nghiệp vụ và bố cục

Chọn kỳ **08/2026**. Kiểm tra đầy đủ danh sách tại [checklist giao diện](2026-09-profit-and-payroll.md), gồm desktop 1280/1440/1920 và mobile 360/390/430. Trên Chrome desktop có thể dùng DevTools → chế độ thiết bị để kiểm tra các chiều rộng mobile.

- Chia lợi nhuận phải hiện cửa hàng A đã khóa kỳ cùng ô hoàn trả setup, dù B chưa khóa. Cửa hàng C mở từ tháng 09 không được chặn kỳ tháng 08.
- A có lợi nhuận sau mọi chi phí là **5.000.000**. Nhập setup **2.000.000**: được chia **3.000.000**, B nhận **1.200.000**, C nhận **1.800.000**. Nút khóa chia lợi nhuận chưa khả dụng khi cửa hàng B còn mở. Ô setup chưa được lưu vào sổ đến khi chốt phân chia toàn kỳ.
- Đăng nhập `qa-manager`, mở Lương thưởng quản lý của cửa hàng B. Lưu lương **4.000.000**, tải lại trang và kiểm tra giữ nguyên. Với doanh thu mẫu **10.000.000**, lương nhân viên **600.000**, thưởng quản lý 2% là **108.000**, tổng chi quản lý **4.108.000**, lợi nhuận còn **5.292.000**.
- Thử đổi kỳ tháng 08 ↔ 09, rồi quay lại tháng 08. Tiêu đề và dữ liệu phải cùng kỳ; phản hồi cũ không được thay thế dữ liệu kỳ mới.
- Tại Lương thưởng của cửa hàng B, xác nhận số liệu → xác nhận đã chi → khóa kỳ. Kiểm tra không báo lỗi JSON, không ghi chi trùng và lương quản lý chuyển sang chỉ đọc. Sau đó admin mới được khóa sổ phân chia toàn kỳ. Kiểm tra xuất CSV và lịch sử.
- Đọc tên cửa hàng/nhân viên dài trong dữ liệu mẫu, số tiền, ghi chú, thông báo, lịch phân ca, bảng, modal và nút. Không được tràn toàn trang, mất chữ hoặc che thao tác. Bảng rộng được cuộn trong vùng riêng.

Kết quả tự động chỉ xác minh dữ liệu và API; người vận hành cần ghi kết quả kiểm tra giao diện thực tế. Nếu thấy lỗi, ghi rõ trang, kỳ, chiều rộng và ảnh trước khi tiếp tục.

## Kết thúc và triển khai

Nhấn `Ctrl+C` để dừng bản thử và tunnel. Dữ liệu mẫu được giữ trong thư mục tạm được in ở terminal để đối chiếu; công cụ không tự xóa thư mục khác.

Chỉ sau khi kiểm tra giao diện đạt: đánh dấu PR sẵn sàng, xác nhận CI đúng head, merge vào `agent/production-update-20260811`, rồi triển khai SHA đã merge bằng `ops/scripts/deploy.sh`. Dùng [runbook](../../ops/README.md) để kiểm tra release, health nội bộ/HTTPS, backup và khả năng rollback. Không dùng bản thử thay cho production.
