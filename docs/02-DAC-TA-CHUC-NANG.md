# 02. Đặc tả chức năng và quy trình

## 1. Luồng đăng nhập

1. Người dùng nhập tên đăng nhập và mật khẩu.
2. Backend kiểm tra khóa tạm, xác minh PBKDF2 và tăng bộ đếm sai nếu thất bại.
3. Khi đúng, bộ đếm sai được xóa, phiên mới được tạo và cookie bảo mật được cấp.
4. Hệ thống điều hướng theo vai trò.
5. Đăng xuất xóa phiên phía server và cookie trình duyệt.

**Ngoại lệ:** từ lần sai thứ 10, tài khoản bị khóa 15 phút và API trả thông báo thời điểm có thể thử lại.

## 2. Tổng quan quản lý

### Dữ liệu đầu vào

- Khoảng thời gian báo cáo.
- Danh sách cửa hàng người quản lý có quyền xem.

### Dữ liệu đầu ra

- Tổng doanh thu, tổng chi phí, tổng lợi nhuận và tỷ lệ lợi nhuận.
- Danh sách năm cửa hàng mặc định và mọi cửa hàng mới được thêm.
- Mỗi thẻ cửa hàng có tên, địa chỉ, trạng thái, doanh thu, lợi nhuận và nút quản lý.

### Hành động

- Click thẻ/nút cửa hàng để đặt ngữ cảnh `selectedStore` và mở dashboard cửa hàng.
- Thêm cửa hàng phải tạo bản ghi, cấu hình chi phí, thiết lập thưởng và các module mặc định trong một giao dịch.
- Xóa cửa hàng cần xác nhận và ưu tiên “ngừng hoạt động” nếu cửa hàng đã có dữ liệu phát sinh.

## 3. Không gian cửa hàng

Mọi màn hình nhận `store_id` từ ngữ cảnh quản lý, không nhận tùy ý từ dữ liệu biểu mẫu của nhân viên.

| Màn hình | Chức năng chính | Dữ liệu tối thiểu |
|---|---|---|
| Tổng quan | KPI, biểu đồ, hoạt động hôm nay | doanh thu, chi phí, lợi nhuận, nhân viên, ca, đơn |
| Ca làm việc | định nghĩa ca và số người | mã ca, giờ bắt đầu/kết thúc, trạng thái |
| Lịch phân ca | xếp nhiều nhân viên theo ngày/ca | ngày, ca, nhân viên, vị trí, ghi chú |
| Nhân viên | CRUD và tài khoản | mã NV, họ tên, SĐT, chức vụ, cửa hàng, trạng thái |
| Nhập hàng | mặt hàng và phiếu nhập | số bao, cân nặng, đơn giá/kg, vận chuyển, thành tiền |
| Chấm công | giờ vào/ra và lương giờ | ca, thời gian thực tế, số giờ, trạng thái đi trễ/vắng |
| Lương thưởng | tổng kết tháng | giờ làm, lương cứng, phụ cấp, thưởng, khấu trừ |
| Đơn hàng | xem toàn bộ đơn cửa hàng | nhân viên, ca, thanh toán, giá trị, trạng thái |
| Dòng tiền | doanh thu/chi phí/lợi nhuận | kỳ, loại giao dịch, số tiền, chứng từ, người tạo |
| Báo cáo | thống kê và xuất tệp | kỳ, cửa hàng, nhóm chỉ số |
| Cài đặt | cấu hình cửa hàng | phụ cấp TikTok, thưởng, chi phí cố định |

## 4. Ca làm và chấm công

### Bắt đầu ca

- Điều kiện: nhân viên có lịch hợp lệ tại cửa hàng chính hoặc cửa hàng hỗ trợ.
- Nếu đã có ca hoạt động, không tạo ca thứ hai.
- Backend lưu `shift_active`, `current_shift`, `shift_started_at` và audit log.

### Kết ca

- Điều kiện: đang có ca hoạt động.
- Ghi nhận thời gian kết thúc, trạng thái công việc, doanh thu/chi phí ca và cờ TikTok.
- Nếu cờ TikTok bật, sinh đúng một khoản phụ cấp theo cấu hình cửa hàng.
- Sau khi kết ca, khóa thao tác thêm/sửa/hủy đơn của ca vừa kết thúc.

### Số giờ và lương cứng

- `Số giờ = Giờ kết ca - Giờ vào`, làm tròn theo chính sách doanh nghiệp.
- `Lương cứng = Số giờ × Lương giờ áp dụng tại thời điểm làm`.
- Lương giờ phải được snapshot vào bản ghi ca để thay đổi sau này không làm sai lịch sử.

## 5. Đơn hàng nhân viên

### Danh sách

API trả dữ liệu khi đồng thời đúng:

```text
store_id = cửa hàng trong phiên
employee_id = nhân viên đăng nhập
shift_code = mã ca đang hoạt động
created_at nằm trong thời gian ca
```

Các thẻ thống kê chỉ cộng đơn có trạng thái `COMPLETED` sau khi áp dụng bộ lọc hiện tại.

### Tạo đơn

1. Nhân viên mở biểu mẫu trong khi ca đang hoạt động.
2. Nhập khách hàng tùy chọn, giá trị bắt buộc và hình thức thanh toán.
3. Backend bỏ qua mọi trường cửa hàng/nhân viên/ca do client gửi.
4. Backend tạo mã `DHxxxxx`, gắn thông tin từ phiên và ghi audit log.

### Sửa đơn

- Chỉ sửa đơn `COMPLETED` của chính nhân viên trong ca đang hoạt động.
- Chỉ sửa thông tin khách hàng, tuổi, SĐT, giá trị và hình thức thanh toán.
- Không sửa mã đơn, nhân viên, cửa hàng, ca hay thời gian tạo.

### Hủy đơn

- Không xóa bản ghi; chuyển `status` sang `VOID`.
- Đơn hủy không tính vào doanh thu nhưng vẫn hiển thị cho quản lý và audit.

## 6. Giao việc

- Quản lý chọn cửa hàng, ca, ngày và nhập một hoặc nhiều nhiệm vụ.
- Mỗi nhiệm vụ gồm nội dung, mô tả, thứ tự và trạng thái.
- Nhân viên trong ca nhìn thấy danh sách và tick hoàn thành.
- Có thể yêu cầu hoàn tất tất cả nhiệm vụ bắt buộc trước khi kết ca.

## 7. Lương thưởng

### Quy trình tổng kết tháng

1. Khóa dữ liệu chấm công của kỳ.
2. Tổng hợp giờ hợp lệ theo nhân viên và cửa hàng chịu chi phí.
3. Tính lương giờ và phụ cấp TikTok.
4. Tính thưởng lợi nhuận theo các ngưỡng trong tài liệu yêu cầu.
5. Cộng thưởng TikTok/thưởng khác do quản lý nhập.
6. Trừ khấu trừ được phê duyệt.
7. Lưu bảng lương snapshot và khóa kỳ.

Khi dữ liệu doanh thu/chi phí thay đổi sau khi khóa, phải mở lại kỳ bằng quyền quản lý và ghi audit log.

## 8. Điều chuyển nhân sự

### Tạo và duyệt

- Cửa hàng điều đi lấy tự động từ hồ sơ chính.
- Cửa hàng nhận không được trùng cửa hàng chính.
- Ngày kết thúc không nhỏ hơn ngày bắt đầu.
- Phải chọn ít nhất một ca hoặc “Cả ngày”.
- Người tạo và người duyệt được lưu riêng.

### Quyền truy cập

- Trước thời gian bắt đầu: chỉ quyền cửa hàng chính.
- Trong khoảng hỗ trợ và đúng ca: thêm quyền cửa hàng nhận.
- Hết hạn/hủy/kết thúc sớm: thu hồi ngay quyền cửa hàng nhận.
- Job định kỳ và kiểm tra thời gian tại mỗi request cùng bảo đảm thu hồi quyền.

### Hạch toán

Ca làm tại cửa hàng nhận hỗ trợ chịu lương, thưởng và phụ cấp của ca đó. Hồ sơ nhân viên và lịch sử tại cửa hàng chính vẫn được giữ nguyên.

## 9. Dòng tiền và báo cáo

- Doanh thu lấy từ đơn hoàn tất và các nguồn thu được duyệt.
- Chi phí phải có loại, cửa hàng, kỳ, số tiền, người tạo và ghi chú/chứng từ.
- Marketing là loại chi phí riêng.
- Báo cáo cửa hàng luôn lọc một `store_id`; báo cáo toàn hệ thống tổng hợp kết quả các cửa hàng.
- Xuất Excel/PDF dùng cùng truy vấn và bộ lọc với giao diện để tránh lệch số.

## 10. Cổ tức

1. Tổng hợp doanh thu và tất cả chi phí đã khóa của kỳ.
2. Tính lợi nhuận sau cùng và tỷ lệ lợi nhuận.
3. Tính cổ tức theo tỷ lệ cổ đông tại kỳ đó.
4. Cho quản lý xem trước, xác nhận và khóa kỳ.
5. Sau khi khóa, chỉ được xem/in/xuất; mọi điều chỉnh phải tạo kỳ điều chỉnh có audit.

## 11. Tiêu chí nghiệm thu chính

- Hai vai trò điều hướng đúng sau đăng nhập.
- Sai mật khẩu 10 lần kích hoạt khóa tạm.
- Nhân viên chưa vào ca không tạo được đơn cả ở UI và API.
- Không thể dùng API để đọc/sửa/hủy đơn của người khác hoặc ca khác.
- Thêm cửa hàng mới xuất hiện ở tổng quan và có đầy đủ không gian quản lý.
- Mọi báo cáo cửa hàng khớp tổng chi tiết cùng bộ lọc.
- Công thức lương/thưởng có kiểm thử tại các ngưỡng 7.000, 15.000 và 30.000.
- Kết thúc điều chuyển tự thu hồi quyền và giữ lịch sử.
- Khóa kỳ cổ tức ngăn chỉnh sửa sau xác nhận.
- Giao diện dùng tốt ở 360 px, máy tính bảng và desktop.

## 12. Ma trận giao diện tham chiếu

### Quản lý toàn hệ thống

- Tổng quan: `ql_giaodienchinh.png`.
- Cửa hàng: `ql_qlch.png`.
- Giao việc: `ql_giaoviec.png`.
- Dòng tiền: `ql_dongtien.png`.
- Lương thưởng quản lý: `ql_luongthuong.png` (không có phụ cấp; lương cố định 3.000.000 đ/cửa hàng và thưởng 2% lợi nhuận).
- Báo cáo: `ql_chinh.png`.
- Cổ tức: `ql_cotuc.png`.
- Điều chuyển nhân sự: `ql_nvhotro.png`.
- Cài đặt: `ql_caidat.png`.

### Không gian quản lý từng cửa hàng

- Ca làm việc: `ql_calamviec.png`; lịch phân ca: `ql_lichphanca.png`.
- Nhân viên: `ql_nvch.png`; nhập hàng: `ql_nhaphang.png`; chấm công: `ql_chamcongnv.png`.
- Lương thưởng: `ql_luongthuongnv.png`; dòng tiền: `ql_dongtien_CH.png`; báo cáo: `ql_baocao_CH.png`.
- Mọi cửa hàng dùng cùng cấu trúc màn hình và chức năng nhưng dữ liệu luôn tách biệt theo `store_id`.

### Nhân viên

- Trang chủ: `nv_giaodienchinh.png`; đơn hàng: `nv_donhang.png`.
- Bảng lương: `nv_bangluong.png`; dòng tiền: `nv_dongtien.png`; lịch sử ca: `nv_lichsuca.png`.
- Mọi thống kê đơn hàng của nhân viên chỉ dùng dữ liệu thuộc ca đang hoạt động.

## 13. Bổ sung nghiệm thu giao diện và nghiệp vụ cửa hàng (08/2026)

### Trang chủ nhân viên và kết ca

- Giao diện trang chủ bám theo `nv_giaodienchinh.png`: điểm danh, thông tin nhân viên, ca hôm nay, bảng công việc, thông tin kết ca, TikTok và lịch sử ca.
- Nút **KẾT CA** chỉ được mở khi đồng thời thỏa mãn: đang có ca hoạt động; tất cả công việc bắt buộc đã được tick; đã nhập doanh thu tiền mặt; đã nhập doanh thu chuyển khoản; nếu chi phí phát sinh lớn hơn 0 thì phải nhập nội dung chi.
- Backend kiểm tra lại toàn bộ điều kiện kết ca, không tin trạng thái nút ở trình duyệt; dữ liệu kết ca được lưu gồm doanh thu theo hình thức thanh toán, chi phí, nội dung chi, trạng thái công việc và cờ TikTok.

### Ca làm việc và lịch phân ca

- Ca làm việc có tên ca, giờ bắt đầu và giờ kết thúc; hỗ trợ thêm, sửa, xóa và xem lịch theo ngày hoặc theo tuần.
- Lịch phân ca bám theo `ql_lichphanca.png`; quản lý chọn ngày, ca và nhiều nhân viên, sau đó có thể lưu, sửa, xóa, lọc và xuất dữ liệu.

### Nhân viên, nhập hàng, chấm công, dòng tiền và báo cáo

- Danh mục nhân viên bám theo `ql_nvch.png`, hỗ trợ tìm kiếm, lọc trạng thái, thêm, sửa, xóa và quản lý tài khoản đăng nhập.
- Nhập hàng bám theo `ql_nhaphang.png`, tự tính thành tiền từ cân nặng, đơn giá và phí vận chuyển; hỗ trợ lịch sử, sửa, xóa và xuất dữ liệu.
- Chấm công bám theo `ql_chamcongnv.png`, lấy dữ liệu ca thực tế, có lọc ngày/ca/trạng thái và xuất dữ liệu.
- Dòng tiền và báo cáo bám theo `ql_dongtien_CH.png` và `ql_baocao_CH.png`, mọi số liệu luôn theo cửa hàng đang chọn và các bộ lọc đang áp dụng.

### Tạo phụ cấp và thưởng nhân viên

- Màn hình lương thưởng bám theo `ql_luongthuongnv.png` và có hai hành động riêng: **Tạo phụ cấp** và **Tạo thưởng**.
- Mỗi lần tạo bắt buộc chọn nhân viên, nhập số tiền lớn hơn 0 và nội dung chi; hệ thống tự gắn cửa hàng, người tạo và thời điểm tạo.
- Lịch sử phụ cấp/thưởng hiển thị đúng nhân viên nhận, loại khoản, số tiền, nội dung và ngày tạo; quản lý có thể lọc, xuất và xóa bản ghi khi kỳ chưa khóa.
