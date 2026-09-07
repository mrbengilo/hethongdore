# Kiểm tra chia lợi nhuận, lương quản lý và giao diện

## Phạm vi

- Hiện số liệu và ô hoàn trả setup của từng cửa hàng đã khóa kỳ, kể cả khi cửa hàng khác chưa chốt.
- Chỉ cho khóa sổ phân chia khi tất cả cửa hàng thuộc kỳ đã khóa; cửa hàng mở sau kỳ không chặn kỳ trước.
- Chuyển lương thưởng quản lý về cửa hàng. Mức lương được lưu riêng theo cửa hàng/kỳ; nếu chưa nhập riêng thì dùng chính sách của kỳ.
- Lương quản lý và thưởng theo công thức hiện có được tính đúng một lần vào chi phí, trước hoàn trả setup và chia lợi nhuận.
- Đồng bộ kỳ giữa các phần lương, tiêu đề cửa hàng và chia lợi nhuận.
- Thu gọn thẻ số liệu, cho tên và số tiền dài xuống dòng, mở rộng dòng ghi chú, giữ bảng rộng trong vùng cuộn có nhãn.

## Kiểm thử tự động

Chạy tại gốc repo bằng Node 22.13 trở lên, dưới Node 23:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm verify:selfhost
```

Các trường hợp nghiệp vụ được kiểm thử trực tiếp qua API và SQLite:

| Trường hợp | Kết quả yêu cầu |
| --- | --- |
| Một cửa hàng LOCKED, cửa hàng khác thiếu kỳ hoặc chưa khóa | Cửa hàng LOCKED vẫn hiện; có danh sách cửa hàng chờ; chưa được khóa sổ toàn kỳ |
| Cửa hàng mở từ 00:00 ngày 01/09 theo giờ Việt Nam | Không chặn chốt tháng 08 |
| Lợi nhuận 5.000.000, setup 2.000.000, tỷ lệ 40/60 | Được chia 3.000.000; thành viên nhận 1.200.000 và 1.800.000 |
| Lương quản lý 4.000.000, doanh thu 10.000.000, các chi phí khác bằng 0, KPI 2% | Thưởng 120.000; tổng chi quản lý 4.120.000; còn 5.880.000 |
| Tiếp tục hoàn trả setup 2.000.000 cho trường hợp trên | Được chia 3.880.000; nhận 1.552.000 và 2.328.000 |
| Hai người cùng lưu lương trên một phiên bản | Một yêu cầu thành công, một yêu cầu nhận 409; không ghi đè |
| Lương thay đổi trong lúc tạo bảng tính | Bản tính cũ bị từ chối, giao dịch không chốt dữ liệu cũ |
| Sửa lương sau khi bắt đầu chốt, sau xác nhận hoặc khóa | Bị chặn tại API và cơ sở dữ liệu |
| Sai quyền cửa hàng, số âm, số lẻ, sai phiên bản | Không ghi dữ liệu hoặc nhật ký thành công |
| Xác nhận chi/khóa lại, lỗi khi ghi sổ | Không chi trùng; kiểm tra rollback và giữ nguyên snapshot |

## Kiểm tra trực quan — chưa hoàn tất

Trình duyệt kiểm thử trong phiên làm việc bị timeout khi kết nối CDP/navigate. Build và kiểm thử mã nguồn không thay thế kiểm tra bố cục thực tế. Không merge hoặc triển khai VPS trước khi hoàn tất các mục sau:

- [ ] Desktop 1280, 1440, 1920 px: tổng quan, cửa hàng, dòng tiền, báo cáo, chia lợi nhuận, nhân viên, chính sách và cài đặt.
- [ ] Mobile 360, 390, 430 px: các trang cửa hàng, lương nhân viên, lương quản lý, lịch phân ca, chấm công, đơn hàng và trang nhân viên.
- [ ] Tên cửa hàng/nhân viên dài và số tiền nhiều chữ số không tràn hoặc bị cắt; không xuất hiện cuộn ngang toàn trang.
- [ ] Box không bị ép bằng chiều cao của box kế bên; ghi chú và trạng thái hiển thị đầy đủ.
- [ ] Đổi kỳ trên tiêu đề cập nhật đồng thời lương nhân viên, lương quản lý và phần chốt; phản hồi kỳ cũ không thay thế kỳ mới.
- [ ] Cửa hàng đã khóa hiện ô setup khi còn cửa hàng khác đang mở; đổi cửa hàng và nhập lại đúng số liệu ví dụ.
- [ ] Nút khóa toàn kỳ vẫn bị vô hiệu khi có cửa hàng chờ; không thể gửi lại thao tác khi đang xử lý.
- [ ] Menu lương quản lý nằm trong cửa hàng; có thể lưu lương trước chốt, xem lại sau tải trang và thấy lương đã giữ nguyên sau chốt.
- [ ] Bàn phím và cảm ứng cuộn được bảng rộng; modal không che nút thao tác; menu, trạng thái tải/rỗng/lỗi đều đọc được.
- [ ] Kiểm tra xuất báo cáo và lịch sử kỳ đã khóa giữ nguyên giá trị.

Sau khi các mục trên đạt, chạy CI trên đúng commit, merge vào `agent/production-update-20260811`, rồi dùng `ops/scripts/deploy.sh` với SHA đã kiểm thử. Script triển khai phải tạo backup trước khi chuyển release và vượt qua health check nội bộ/HTTPS. Không dùng dữ liệu chi trả thật để thử thao tác tài chính.
