# 02. Đặc tả chức năng và quy trình

> Quy tắc tài chính, lương, lợi nhuận và chốt kỳ chi tiết xem `docs/06-TAI-CHINH-LUONG-LOI-NHUAN-CHOT-KY.md`.
> Quy tắc ca làm và chấm công thực tế xem `docs/05-TU-DONG-CHUYEN-CA.md` (tên file được giữ để tương thích lịch sử, nội dung hiện tại đã thay thế auto-rollover cũ).

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

- Tổng doanh thu, tổng chi phí, lợi nhuận theo đúng Finance Engine và tỷ lệ lợi nhuận.
- Danh sách cửa hàng đang hoạt động lấy từ dữ liệu thực, không hard-code số lượng cửa hàng.
- Mỗi thẻ cửa hàng có tên, địa chỉ, trạng thái, doanh thu, lợi nhuận và nút quản lý.

### Hành động

- Click thẻ/nút cửa hàng để đặt ngữ cảnh `selectedStore` và mở dashboard cửa hàng.
- Thêm cửa hàng phải tạo bản ghi và các cấu hình/module mặc định cần thiết một cách an toàn.
- Xóa cửa hàng cần xác nhận và ưu tiên “ngừng hoạt động” nếu cửa hàng đã có dữ liệu phát sinh.

## 3. Không gian cửa hàng

Mọi màn hình nhận `store_id` từ ngữ cảnh/quyền hợp lệ, không tin cậy tùy ý giá trị cửa hàng do client gửi.

| Màn hình | Chức năng chính | Dữ liệu tối thiểu |
|---|---|---|
| Tổng quan | KPI, biểu đồ, hoạt động hôm nay | doanh thu, chi phí, lợi nhuận, nhân viên, ca, đơn |
| Ca làm việc | định nghĩa ca và số người | mã ca, giờ bắt đầu/kết thúc dự kiến, trạng thái |
| Lịch phân ca | xếp nhiều nhân viên theo ngày/ca | ngày, ca, nhân viên, vị trí, ghi chú |
| Nhân viên | CRUD và tài khoản | mã NV, họ tên, SĐT, chức vụ, cửa hàng, trạng thái |
| Nhập hàng | mặt hàng và phiếu nhập | số bao, cân nặng, đơn giá/kg, vận chuyển, thành tiền |
| Chấm công | giờ vào/ra thực tế và lương giờ | ca, thời gian thực tế, số giờ, trạng thái |
| Lương thưởng | tổng kết tháng | giờ làm, lương, phụ cấp, thưởng, ứng lương, KPI, thực nhận |
| Đơn hàng | xem toàn bộ đơn cửa hàng | nhân viên, ca, thanh toán, giá trị, trạng thái |
| Dòng tiền | tiền vào/ra | kỳ, loại giao dịch, số tiền, nguồn, chứng từ, người tạo |
| Chi phí cuối kỳ | khoản khấu trừ cuối kỳ trước chia lợi nhuận | tháng, loại, số tiền, ghi chú, người tạo |
| Báo cáo | thống kê và xuất tệp | kỳ, cửa hàng, nhóm chỉ số |
| Cài đặt | cấu hình cửa hàng | phụ cấp, lương quản lý, KPI/config có hiệu lực |

## 4. Ca làm và chấm công

### Bắt đầu ca

- Điều kiện: nhân viên có quyền làm việc hợp lệ tại cửa hàng/ca tương ứng theo business rule hiện hành.
- Nếu đã có phiên làm việc hoạt động, không tạo phiên trùng.
- Backend lưu phiên chấm công và audit cần thiết.

### Giờ dự kiến và giờ thực tế

Phải phân biệt:

- `scheduled_start_at`;
- `scheduled_end_at`;
- `actual_start_at`/`started_at`;
- `actual_end_at`/`ended_at`.

Lịch ca là kế hoạch; giờ thực tế là dữ liệu tính công.

### Kết ca

- Điều kiện: đang có phiên làm việc hoạt động.
- Ghi nhận thời gian kết thúc thực tế, trạng thái công việc và các dữ liệu liên quan.
- Nếu có phụ cấp TikTok hoặc phụ cấp theo ca, sử dụng cấu hình áp dụng và snapshot giá trị, không hard-code trong Finance Engine.
- Sau khi kết ca, các thao tác nghiệp vụ cần tuân thủ rule quyền và trạng thái ca hiện hành.

### Overtime

Nếu nhân viên làm quá giờ kết thúc dự kiến nhưng chưa kết ca:

- tiếp tục giữ cùng phiên làm việc;
- thời gian vượt giờ là overtime;
- không tự động đóng ca cũ và tạo ca kế tiếp chỉ vì vượt một grace period;
- một phiên có thể đi qua 00:00.

### Số giờ và lương

- `Số giờ = Giờ kết thúc thực tế - Giờ bắt đầu thực tế`.
- `Lương = Số giờ hợp lệ × Lương giờ áp dụng`.
- Lương giờ/config áp dụng phải được snapshot/version phù hợp để thay đổi sau này không làm sai lịch sử.

### Quản lý điều chỉnh

Quản lý được tạo ca linh động, sửa lịch ca hoặc điều chỉnh giờ chấm công hợp lệ trước khi kỳ khóa. Các thay đổi ảnh hưởng lịch sử phải có audit gồm before, after, actor, reason và timestamp.

## 5. Đơn hàng nhân viên

### Danh sách

API trả dữ liệu theo đúng quyền cửa hàng, nhân viên và ca/phiên hợp lệ.

Các thống kê doanh thu chỉ cộng đơn hợp lệ ở trạng thái `COMPLETED` sau khi áp dụng bộ lọc hiện tại.

### Tạo đơn

1. Nhân viên mở biểu mẫu khi có quyền nghiệp vụ hợp lệ.
2. Nhập khách hàng tùy chọn, giá trị bắt buộc và hình thức thanh toán.
3. Backend không tin cậy các trường identity/scope nhạy cảm do client tự gán; phải xác minh từ session/quyền.
4. Backend tạo mã đơn, gắn scope hợp lệ và ghi audit log.

### Sửa đơn

- Chỉ cho phép theo đúng quyền và trạng thái nghiệp vụ.
- Không sửa các identity field nhạy cảm nếu business rule không cho phép.

### Hủy đơn

- Ưu tiên soft-delete/VOID để giữ lịch sử.
- Đơn hủy không tính vào doanh thu nhưng vẫn audit được.

## 6. Giao việc

- Quản lý chọn cửa hàng, ca, ngày và nhập một hoặc nhiều nhiệm vụ.
- Mỗi nhiệm vụ gồm nội dung, mô tả, thứ tự và trạng thái.
- Nhân viên trong phạm vi phù hợp nhìn thấy danh sách và tick hoàn thành.
- Có thể yêu cầu hoàn tất nhiệm vụ bắt buộc trước khi kết ca nếu business rule hiện hành yêu cầu.

## 7. Lương thưởng và chốt kỳ

### Nguyên tắc

Payroll phải dùng cùng nguồn dữ liệu với Finance Engine và chấm công thực tế.

Nhân viên đã làm trong kỳ vẫn phải được tính đầy đủ dù sau đó nghỉ việc, archive hoặc chuyển cửa hàng.

Ứng lương là khoản trả trước, không được làm chi phí lương bị tính lần hai.

### Workflow kỳ chuẩn

`DRAFT → CALCULATED → RECONCILING → CONFIRMED → PAID → LOCKED`

1. Trong `DRAFT`, nghiệp vụ tháng hoạt động bình thường.
2. Khi hết kỳ, hệ thống tổng hợp sang `CALCULATED`; có thể tự chuyển lúc 00:00 ngày 01 tháng kế tiếp nhưng không auto-lock.
3. Trong `RECONCILING`, quản lý đối soát doanh thu, chi phí, chấm công, lương, thưởng, phụ cấp, ứng lương, KPI và chi phí cuối kỳ; nếu sai thì sửa dữ liệu nguồn hợp lệ và recalculate.
4. `CONFIRMED`: xác nhận số liệu và tạo snapshot.
5. `PAID`: ghi nhận đã chi lương/thưởng theo quy trình.
6. `LOCKED`: khóa kỳ và giữ lịch sử bất biến.

Kỳ `LOCKED` không được mở lại để rewrite lịch sử. Nếu cần điều chỉnh, phải dùng adjustment/workflow điều chỉnh có audit.

## 8. Điều chuyển nhân sự

### Tạo và duyệt

- Cửa hàng điều đi lấy từ hồ sơ chính.
- Cửa hàng nhận không được trùng cửa hàng chính.
- Ngày kết thúc không nhỏ hơn ngày bắt đầu.
- Phải chọn ít nhất một ca hoặc “Cả ngày” nếu flow hiện hành sử dụng khái niệm này.
- Người tạo và người duyệt được lưu riêng.

### Quyền truy cập

- Quyền cửa hàng nhận chỉ tồn tại trong phạm vi thời gian/ca hỗ trợ hợp lệ.
- Hết hạn/hủy/kết thúc sớm phải thu hồi quyền.
- Backend luôn xác minh scope, không phụ thuộc riêng UI.

### Hạch toán

Ca làm tại cửa hàng nhận hỗ trợ chịu chi phí theo business rule đã xác nhận. Hồ sơ và lịch sử nhân viên vẫn được giữ nguyên.

## 9. Dòng tiền, chi phí và báo cáo

### Dòng tiền

`Cashflow != Expense`.

Dòng tiền phản ánh tiền vào/ra thực tế. Chi phí là nghiệp vụ ảnh hưởng P&L/lợi nhuận.

Nếu một dòng tiền phát sinh từ một expense/payroll/inventory đã tồn tại, phải liên kết qua `sourceType/sourceId` hoặc reference tương đương và không được cộng thêm lần hai vào profit.

### Finance Engine

Chuỗi chuẩn:

`Revenue → Fixed Expense → Variable Expense → Inventory → Shipping → Salary → Bonus → Allowance → Operating Profit → Employee KPI → Manager KPI → Profit After KPI → Month-End Expense → Final Profit → Distributable Profit`

Chi phí cố định phải cộng toàn bộ bản ghi hợp lệ trong kỳ, không chỉ lấy bản ghi mới nhất.

### Chi phí cuối kỳ

Quản lý có thể nhập nhiều khoản chi phí cuối kỳ trong tháng trước khi khóa kỳ. Tổng các khoản hợp lệ tạo thành `MONTH_END_EXPENSE`.

`FINAL_PROFIT = PROFIT_AFTER_KPI - MONTH_END_EXPENSE`

Final Profit có thể âm.

### Báo cáo

- Báo cáo cửa hàng lọc đúng store/kỳ.
- Báo cáo toàn hệ thống tổng hợp từ cùng Finance Engine hoặc snapshot.
- Xuất Excel/PDF phải dùng cùng nguồn/bộ lọc với giao diện.
- Không hard-code số lượng cửa hàng, % tăng trưởng, ngày tháng hoặc dữ liệu demo vào production report.

## 10. Cổ tức / chia lợi nhuận

1. Lấy `FINAL_PROFIT` từ Finance Engine/snapshot của kỳ.
2. Nếu `FINAL_PROFIT <= 0` thì `DISTRIBUTABLE_PROFIT = 0` và không chia.
3. Nếu `FINAL_PROFIT > 0` thì `DISTRIBUTABLE_PROFIT = FINAL_PROFIT`.
4. Chỉ `DISTRIBUTABLE_PROFIT` được dùng để tính chia lợi nhuận/cổ tức theo tỷ lệ áp dụng của kỳ.
5. Cho quản lý xem trước và xác nhận theo workflow.
6. Sau khi khóa kỳ, chỉ xem/in/xuất; điều chỉnh phải qua adjustment có audit.

Không dùng Revenue, Operating Profit hoặc Profit After KPI để chia lợi nhuận.

## 11. Tiêu chí nghiệm thu chính

- Hai vai trò điều hướng đúng sau đăng nhập.
- Cơ chế khóa đăng nhập hoạt động đúng theo policy hiện hành.
- Nhân viên không có quyền/ca hợp lệ không tạo được đơn cả ở UI và API.
- Không thể dùng API để bypass scope cửa hàng/nhân viên.
- Thêm cửa hàng mới xuất hiện từ dữ liệu thực; UI không hard-code số lượng cửa hàng.
- Mọi báo cáo khớp Finance Engine/snapshot cùng kỳ.
- Overtime không tự tạo ca kế tiếp.
- Chấm công qua 00:00 tính đúng giờ thực tế.
- Lương lấy từ giờ thực tế hợp lệ.
- Kỳ `LOCKED` không bị rewrite.
- Fixed Expense cộng đúng tất cả khoản hợp lệ.
- Cashflow không double-count expense.
- `Final Profit = Profit After KPI - Month-End Expense`.
- Chỉ `Distributable Profit` được dùng để chia lợi nhuận/cổ tức.
- Giao diện dùng tốt tối thiểu ở 360 px, 390 px, 430 px, máy tính bảng và desktop.
