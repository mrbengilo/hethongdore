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
- Không có thao tác xóa cửa hàng. Quản lý chỉ chuyển trạng thái giữa `ACTIVE` (đang hoạt động) và `INACTIVE` (ngưng hoạt động).

### Vòng đời cửa hàng

- Cửa hàng mới luôn được tạo ở trạng thái `ACTIVE`.
- Trước khi chuyển `ACTIVE → INACTIVE`, backend phải xác nhận cửa hàng không còn ca đang hoạt động; nếu còn, trả lỗi và giữ nguyên trạng thái.
- Cửa hàng `INACTIVE` vẫn xuất hiện trên tổng quan và cho phép quản lý/nhân viên được phân quyền đọc lịch sử ca, đơn hàng, dòng tiền, lương và báo cáo.
- Mọi thao tác phát sinh dữ liệu mới tại cửa hàng `INACTIVE` phải bị từ chối ở backend, gồm nhân viên, lịch/ca làm, đơn hàng, giao việc, nhập hàng, chấm công, dòng tiền, lương thưởng và điều chuyển mới. Việc ẩn hoặc khóa nút trên giao diện chỉ là lớp hỗ trợ.
- Kích hoạt lại chuyển `INACTIVE → ACTIVE` và không làm thay đổi dữ liệu lịch sử. Mỗi lần đổi trạng thái phải được ghi audit với trạng thái trước/sau.

## 3. Không gian cửa hàng

Mọi màn hình nhận `store_id` từ ngữ cảnh quản lý, không nhận tùy ý từ dữ liệu biểu mẫu của nhân viên.

### Liên kết tài khoản nhân viên với cửa hàng

- Khi quản lý tạo nhân viên trong một cửa hàng, backend phải kiểm tra cửa hàng tồn tại và đang `ACTIVE`, sau đó lưu cùng một `store_id` vào cả `employees.store_id` và `users.store_id` trong một giao dịch.
- API trả lại `storeId` đã lưu để giao diện đối chiếu. Không được suy ra hoặc sửa cửa hàng của nhân viên từ mã nhân viên, tên đăng nhập, thứ tự tạo hay tên cửa hàng mặc định.
- Sau đăng nhập, cửa hàng chính lấy từ tài khoản/hồ sơ đã liên kết; nhân viên chỉ thấy dữ liệu cửa hàng đó. Ngoại lệ duy nhất là cửa hàng hiệu lực do một đợt điều chuyển hợp lệ mà backend xác định.
- Khi quản lý chuyển nhân viên sang cửa hàng chính khác, cả hồ sơ và tài khoản phải được cập nhật đồng nhất; phiên đăng nhập hiện hữu cần được thu hồi hoặc làm mới phạm vi.

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
- Phiên ca lưu riêng mã phiên duy nhất `shift_code` và tên hiển thị `shift_name` (Ca 1/Ca 2/Ca 3), cùng `work_date`, giờ lịch, cửa hàng chịu chi phí, mã điều chuyển nếu có và lương giờ áp dụng.
- `work_date` được xác định theo `Asia/Ho_Chi_Minh`; không cắt trực tiếp ngày UTC để lọc lịch sử.

### Kết ca

- Điều kiện: đang có ca hoạt động; toàn bộ công việc bắt buộc đã hoàn thành; nhân viên đã nhập chi phí, tiền mặt và chuyển khoản. Không có chi phí hoặc một hình thức doanh thu vẫn phải nhập giá trị 0.
- Nếu chi phí lớn hơn 0, nội dung chi là bắt buộc.
- Nếu `tiền mặt + chuyển khoản > 0`, backend phải tìm thấy ít nhất một đơn `COMPLETED` có đúng cửa hàng, nhân viên và `shift_code` của ca hiện tại; đơn hủy, đơn ca khác hoặc nhân viên khác không thỏa điều kiện.
- Ghi nhận thời gian kết thúc, trạng thái công việc, doanh thu/chi phí ca và cờ TikTok vào `shift_sessions` trước khi xóa trạng thái ca đang mở của tài khoản.
- Nếu cờ TikTok bật, sinh đúng một khoản phụ cấp theo cấu hình cửa hàng.
- Sau khi kết ca, khóa thao tác thêm/sửa/hủy đơn của ca vừa kết thúc.
- API trả thời gian kết thúc và thông báo đã ghi lịch sử; lịch sử dùng `shift_name`, `work_date`, mã/tên nhân viên thật thay vì dữ liệu ghi cứng.

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

### Hợp đồng snapshot KPI

- Preview tháng tổng hợp các `shift_sessions` đã hoàn thành theo cửa hàng chịu chi phí và kỳ Việt Nam.
- Lương cứng dùng `applied_hourly_rate` đã snapshot tại lúc bắt đầu ca; ca hỗ trợ dùng lương hỗ trợ của đợt điều chuyển.
- Tỷ lệ KPI được chọn một lần từ `P/H`: dưới 7.000 là 0%; từ 7.000 là 3%; từ 15.000 là 5%; từ 30.000 là 7%. Các ngưỡng không cộng dồn.
- Thưởng từng người là `(giờ người đó / tổng giờ cửa hàng) × tỷ lệ × lợi nhuận` và được làm tròn về số nguyên đồng.
- Khi quản lý bấm tổng kết, hệ thống lưu một bản ghi `KPI_SUMMARY` trạng thái `LOCKED` duy nhất theo `store_id + period`, gồm toàn bộ đầu vào, tỷ lệ và kết quả từng nhân viên.
- GET kỳ đã khóa luôn trả snapshot; tài khoản nhân viên chỉ nhận dòng lương của chính mình.

## 8. Điều chuyển nhân sự

### Tạo và duyệt

- Cửa hàng điều đi lấy tự động từ hồ sơ chính.
- Cửa hàng nhận không được trùng cửa hàng chính.
- Ngày kết thúc không nhỏ hơn ngày bắt đầu.
- Phải chọn ít nhất một ca hoặc “Cả ngày”.
- Người tạo và người duyệt được lưu riêng.

### Quyền truy cập

- Trước thời gian bắt đầu: chỉ quyền cửa hàng chính.
- Trong khoảng hỗ trợ: backend xác định cửa hàng hiệu lực là cửa hàng nhận từ `employee_transfers`; ca áp dụng được lưu cùng đợt hỗ trợ và lịch phân ca của cửa hàng nhận quyết định ca thực tế.
- Hết hạn/hủy/kết thúc sớm: thu hồi ngay quyền cửa hàng nhận.
- Kiểm tra thời gian tại mỗi request bảo đảm quyền hết hiệu lực ngay cả khi chưa chạy tác vụ đồng bộ trạng thái; API điều chuyển đồng thời tự chuyển `SCHEDULED → ACTIVE → COMPLETED` theo ngày Việt Nam.
- Nếu nhân viên đang ở trong một ca hỗ trợ, `shift_sessions.store_id`, `transfer_id` và `applied_hourly_rate` là snapshot của ca đó; quyền và hạch toán ca không bị đổi giữa chừng.

### Hạch toán

Ca làm tại cửa hàng nhận hỗ trợ chịu lương, thưởng và phụ cấp của ca đó. Hồ sơ nhân viên và lịch sử tại cửa hàng chính vẫn được giữ nguyên.

## 9. Dòng tiền và báo cáo

- Doanh thu lấy từ đơn hoàn tất và các nguồn thu được duyệt.
- Chi phí phải có loại, cửa hàng, kỳ, số tiền, người tạo và ghi chú/chứng từ.
- Marketing là loại chi phí riêng.
- Báo cáo cửa hàng luôn lọc một `store_id`; báo cáo toàn hệ thống tổng hợp kết quả các cửa hàng.
- Xuất Excel/PDF dùng cùng truy vấn và bộ lọc với giao diện để tránh lệch số.

### Chi phí cố định theo cửa hàng

- Mỗi cửa hàng có cấu hình riêng cho tối thiểu: setup, mặt bằng, điện, nước, wifi, rác, marketing và chi phí khác.
- Mỗi cấu hình phải có `store_id`, loại chi phí, số tiền VND, kỳ bắt đầu áp dụng, ghi chú, người cập nhật và thời điểm cập nhật. Thay đổi mức tiền tạo phiên bản theo kỳ, không ghi đè số đã dùng trong kỳ đã khóa.
- Khi tổng kết tháng, hệ thống chỉ lấy các mức chi phí có hiệu lực của đúng cửa hàng và đúng kỳ; chi phí marketing là một khoản độc lập, không gộp ngầm vào “khác”.
- Tổng chi phí cửa hàng gồm chi phí cố định, giá vốn/nhập hàng, lương nhân viên, lương quản lý, phụ cấp, thưởng và các chi phí phát sinh hợp lệ. Báo cáo phải chỉ rõ từng nhóm để có thể đối soát.

### Quy ước tiền tệ và thời gian

- Mọi số tiền VND lưu bằng `INTEGER` 64-bit của SQLite/D1, đơn vị đồng, không dùng `float` và không lưu chuỗi đã định dạng. Phép nhân tỷ lệ/chia phân bổ dùng hàm decimal/số nguyên dùng chung và làm tròn một lần về đồng.
- Timestamp kỹ thuật (`created_at`, `updated_at`, giờ vào/ra thực tế, audit) lưu theo UTC chuẩn ISO 8601. Ngày làm việc, kỳ tháng và nội dung hiển thị được chuyển theo `Asia/Ho_Chi_Minh` ở biên nghiệp vụ; không cắt trực tiếp ngày từ chuỗi UTC.

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
- Không thể xóa cửa hàng; cửa hàng `INACTIVE` đọc được lịch sử nhưng mọi API ghi nghiệp vụ trả lỗi. Không thể ngưng cửa hàng khi còn ca hoạt động.
- Nhân viên mới đăng nhập chỉ thấy đúng cửa hàng nơi tài khoản được tạo; mã nhân viên giống dữ liệu mẫu không được làm thay đổi `store_id`.
- Mọi báo cáo cửa hàng khớp tổng chi tiết cùng bộ lọc.
- Chi phí cố định được áp dụng đúng cửa hàng/kỳ, gồm ô marketing riêng và không thay đổi kỳ đã khóa.
- Số tiền lớn vẫn giữ chính xác trong miền `INTEGER` 64-bit; ca qua nửa đêm được gán đúng ngày/kỳ `Asia/Ho_Chi_Minh` dù timestamp lưu UTC.
- Công thức lương/thưởng có kiểm thử tại các ngưỡng 7.000, 15.000 và 30.000.
- Thưởng KPI chưa xuất hiện như kết quả chính thức trước khi quản lý tổng kết; gửi tổng kết lần hai cho cùng cửa hàng/kỳ bị từ chối.
- Không thể kết ca với doanh thu dương nếu không có đơn hoàn tất đúng ca; nhập 0 cho chi phí và hai hình thức doanh thu vẫn được chấp nhận.
- Lịch sử ca hiển thị/lọc theo `shift_name` và `work_date` Việt Nam, không theo mã phiên ngẫu nhiên.
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
- Nút **KẾT CA** chỉ được mở khi đồng thời thỏa mãn: đang có ca hoạt động; tất cả công việc bắt buộc đã được tick; đã nhập chi phí (nhập 0 nếu không có); đã nhập doanh thu tiền mặt; đã nhập doanh thu chuyển khoản; nếu chi phí phát sinh lớn hơn 0 thì phải nhập nội dung chi.
- Khi doanh thu dương mà chưa có đơn hoàn tất trong ca, giao diện hiển thị yêu cầu nhập đơn và backend từ chối kết ca. Backend kiểm tra lại toàn bộ điều kiện, không tin trạng thái nút ở trình duyệt; dữ liệu kết ca được lưu gồm doanh thu theo hình thức thanh toán, chi phí, nội dung chi, trạng thái công việc và cờ TikTok.

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
