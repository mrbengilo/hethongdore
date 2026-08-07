# 01. Yêu cầu hệ thống DORE

## 1. Mục tiêu

Xây dựng một hệ thống thống nhất để quản lý chuỗi cửa hàng DORE, bảo đảm dữ liệu từng cửa hàng độc lập nhưng vẫn tổng hợp được ở cấp toàn hệ thống. Hệ thống chỉ có hai vai trò nghiệp vụ: **Quản lý** và **Nhân viên**.

## 2. Phạm vi cửa hàng ban đầu

1. DORE THỐT NỐT.
2. DORE CẦN THƠ.
3. DORE LONG XUYÊN.
4. DORE VĨNH LONG.
5. DORE SÓC TRĂNG.

Quản lý được thêm, sửa và chuyển cửa hàng giữa hai trạng thái `ACTIVE`/`INACTIVE`; không xóa cửa hàng đã tạo. Khi thêm cửa hàng, hệ thống phải tạo cấu hình mặc định, các danh mục quản trị, không gian nhân viên và cấu trúc báo cáo tương tự cửa hàng hiện hữu. Cửa hàng ngưng hoạt động chỉ cho phép đọc lịch sử dòng tiền/báo cáo; mọi thao tác phát sinh dữ liệu mới bị khóa ở cả giao diện và backend.

## 3. Vai trò và phân quyền

### 3.1. Quản lý

- Đăng nhập vào trang tổng quan toàn hệ thống.
- Xem, thêm, sửa và thay đổi trạng thái hoạt động của cửa hàng; không xóa vật lý cửa hàng.
- Chọn một cửa hàng để chuyển sang không gian quản lý cửa hàng đó.
- Xem dữ liệu của mọi nhân viên, mọi ca và mọi đơn hàng.
- Quản lý ca làm, lịch phân ca, chấm công, nhập hàng, nhân viên, lương thưởng, dòng tiền và báo cáo.
- Giao việc theo cửa hàng, ca và ngày áp dụng.
- Điều chuyển nhân sự hỗ trợ giữa các cửa hàng.
- Quản lý lương thưởng của quản lý, báo cáo toàn hệ thống và cổ tức.
- Thiết lập tiền phụ cấp TikTok, thưởng TikTok và thưởng khác theo từng cửa hàng.

### 3.2. Nhân viên

- Chỉ truy cập dữ liệu của cửa hàng trực thuộc.
- Trong thời gian điều chuyển hợp lệ, được truy cập cửa hàng nhận hỗ trợ theo đúng ngày và ca được duyệt.
- Xem trang chủ, đơn hàng, bảng lương, dòng tiền cá nhân/ca và lịch sử ca làm.
- Điểm danh bắt đầu ca, hoàn thành công việc và kết ca.
- Tạo đơn hàng trong ca hiện tại; không được tự chọn cửa hàng, nhân viên hoặc ca khác.
- Không được xem, sửa hoặc hủy dữ liệu của nhân viên khác hay ca khác.

## 4. Yêu cầu đăng nhập và bảo mật

- Biểu mẫu gồm tên đăng nhập, mật khẩu, hiện/ẩn mật khẩu, ghi nhớ đăng nhập, quên mật khẩu và đăng xuất.
- Sai thông tin phải hiển thị thông báo dễ hiểu, không tiết lộ tài khoản có tồn tại hay không.
- Khóa tạm thời sau 10 lần đăng nhập sai liên tiếp.
- Sau đăng nhập, quản lý chuyển đến `/manager`, nhân viên chuyển đến `/employee`.
- Mật khẩu phải được băm ở backend; cấm lưu hoặc ghi log mật khẩu dạng văn bản thuần.
- Phiên đăng nhập sử dụng cookie `HttpOnly`, `SameSite` và thời hạn phù hợp.
- Mọi thao tác quan trọng phải kiểm tra quyền ở backend, không chỉ ẩn nút ở giao diện.
- Ghi nhật ký các thao tác tạo, sửa, hủy đơn và các thay đổi quản trị quan trọng.

## 5. Danh mục quản lý toàn hệ thống

1. **Tổng quan:** doanh thu, chi phí, lợi nhuận, danh sách cửa hàng và điều hướng vào từng cửa hàng.
2. **Cửa hàng:** thêm/sửa, trạng thái hoạt động/ngưng hoạt động, nhân sự, doanh thu, chi phí và lợi nhuận.
3. **Giao việc:** chọn cửa hàng, ca, ngày; tạo danh sách nhiệm vụ và gửi cho nhân viên.
4. **Dòng tiền:** lọc theo cửa hàng/thời gian; thống kê doanh thu, chi phí và lợi nhuận.
5. **Lương thưởng quản lý:** lương cố định và thưởng theo cửa hàng; không có phụ cấp quản lý.
6. **Báo cáo:** báo cáo toàn chuỗi hoặc theo cửa hàng; xuất Excel/PDF.
7. **Điều chuyển nhân sự:** tạo, duyệt, hủy, gia hạn và kết thúc hỗ trợ.
8. **Cổ tức:** lợi nhuận sau cùng, tỷ lệ cổ đông, khóa kỳ và lịch sử chia.
9. **Cài đặt:** hồ sơ, mật khẩu, thông báo, ngôn ngữ và đăng xuất.

## 6. Danh mục quản lý từng cửa hàng

1. Tổng quan.
2. Ca làm việc.
3. Lịch phân ca.
4. Nhân viên.
5. Nhập hàng.
6. Chi phí cố định.
7. Chấm công.
8. Lương thưởng.
9. Đơn hàng.
10. Dòng tiền.
11. Báo cáo.
12. Cài đặt.

Mọi truy vấn, thống kê và xuất báo cáo trong không gian cửa hàng phải lọc bắt buộc theo `store_id`.

## 7. Danh mục nhân viên

1. **Trang chủ:** điểm danh, thông tin cá nhân, ca hôm nay, công việc cần làm, kết ca và xác nhận clip TikTok.
2. **Đơn hàng:** đơn thuộc ca hiện tại, thống kê thanh toán, tìm kiếm, thêm, xem, sửa, hủy và xuất dữ liệu.
3. **Bảng lương:** giờ làm, lương cứng, thưởng, phụ cấp và tổng thu nhập.
4. **Dòng tiền:** doanh thu, chi phí và lợi nhuận tạm tính của ca hiện tại.
5. **Lịch sử ca làm:** lọc theo ngày/ca, giờ vào/ra, số giờ và lương dự tính.

Khi bắt đầu ca, hệ thống phải ghi thời gian vào thực tế và snapshot `shift_name`, `work_date`, khung giờ đã xếp, cửa hàng thực tế cùng mức lương giờ áp dụng. `shift_code` tiếp tục là mã phiên duy nhất dùng để liên kết đơn hàng; không dùng mã phiên này thay cho tên Ca 1, Ca 2 hoặc Ca 3 trên giao diện.

## 8. Quy tắc đơn hàng

- Mã đơn tự tạo theo mẫu `DHxxxxx` và duy nhất toàn hệ thống.
- Tên khách hàng, số điện thoại và tuổi là tùy chọn.
- Bắt buộc có giá trị đơn hàng dương và hình thức `Tiền mặt` hoặc `Chuyển khoản`.
- Đơn mới tự gắn `store_id`, `employee_id`, `shift_code` và thời gian tạo từ phiên backend.
- Khi chưa bắt đầu ca, hiển thị “Bạn chưa bắt đầu ca làm việc” và khóa chức năng thêm đơn.
- Thống kê đầu trang chỉ tính đơn hoàn tất trong ca hiện tại.
- Hủy đơn chuyển trạng thái sang `VOID`, không xóa vật lý, nhằm bảo toàn đối soát.
- Quản lý được xem đơn của mọi nhân viên và mọi ca; nhân viên chỉ thao tác đơn của chính mình trong ca đang hoạt động.
- Trước khi kết ca, nhân viên phải hoàn thành toàn bộ công việc bắt buộc, nhập chi phí kể cả khi giá trị bằng 0, nhập doanh thu tiền mặt và chuyển khoản; chi phí lớn hơn 0 phải có nội dung chi.
- Nếu tổng doanh thu nhập khi kết ca lớn hơn 0 nhưng ca hiện tại không có đơn `COMPLETED`, hệ thống phải từ chối kết ca và yêu cầu nhân viên nhập đơn hàng. Điều kiện này được kiểm tra lại ở backend.
- Trước khi kết ca, backend cộng độc lập các đơn `COMPLETED` theo từng hình thức thanh toán trong đúng `store_id + employee_id + shift_code`. Tiền mặt nhập phải bằng tổng đơn tiền mặt và chuyển khoản nhập phải bằng tổng đơn chuyển khoản. Nếu lệch, hệ thống từ chối kết ca và trả rõ số đúng, số đã nhập và phần chênh lệch của từng hình thức.
- Kết ca thành công phải ghi `ended_at`, doanh thu, chi phí, trạng thái hoàn thành và lịch sử ca trước khi xóa trạng thái ca đang hoạt động của tài khoản.

## 9. Lương, thưởng và lợi nhuận

### 9.1. Quản lý

- Lương cố định: 3.000.000 đồng cho mỗi cửa hàng mỗi tháng.
- Thưởng quản lý theo cửa hàng: `2% × lợi nhuận dương của cửa hàng`.
- Tổng thưởng ngoài trang quản lý hệ thống bằng tổng thưởng của các cửa hàng.
- Danh mục lương thưởng quản lý không có phụ cấp.

### 9.2. Nhân viên

Gọi `P` là lợi nhuận cửa hàng trong tháng, `H` là tổng giờ làm của tất cả nhân viên và `h` là giờ làm của nhân viên:

- Nếu `P/H < 7.000`: thưởng lợi nhuận bằng 0.
- Nếu `7.000 ≤ P/H < 15.000`: thưởng = `(h/H) × 3% × P`.
- Nếu `15.000 ≤ P/H < 30.000`: thưởng = `(h/H) × 5% × P`.
- Nếu `P/H ≥ 30.000`: thưởng = `(h/H) × 7% × P`.

Tổng nhận nhân viên gồm lương theo giờ, thưởng lợi nhuận, phụ cấp TikTok, thưởng TikTok, thưởng khác và phụ cấp khác, sau khi trừ các khoản khấu trừ hợp lệ.

Thưởng KPI chỉ trở thành số liệu chính thức sau khi **Quản lý tổng kết tháng** cho từng cửa hàng. Hệ thống tính một preview từ dữ liệu ca đã hoàn thành, chọn đúng một ngưỡng cao nhất đạt được (không cộng dồn), sau đó lưu snapshot kỳ gồm lợi nhuận, tổng giờ, tỷ lệ KPI và chi tiết từng nhân viên. Snapshot đã khóa không tự thay đổi khi dữ liệu nguồn hoặc lương giờ được chỉnh sửa về sau; nhân viên chỉ xem kết quả của chính mình trong kỳ đã tổng kết.

Kỳ lương tại cửa hàng có vòng đời `DRAFT` → `FINALIZED` → `PAID` → `LOCKED`. Quản lý được xem trước, chốt lương/thưởng của nhân viên và quản lý, xác nhận chi, kết sổ và khóa kỳ. Sau khi khóa, dữ liệu không được sửa; lịch sử, thống kê và so sánh kỳ trước vẫn phải đọc/xuất được.

### 9.3. Phụ cấp TikTok

- Quản lý đặt mức phụ cấp TikTok riêng cho từng cửa hàng.
- Khi kết ca, nhân viên tick “Ca này có làm clip TikTok”.
- Hệ thống ghi nhận một khoản phụ cấp cho ca đó, không được ghi trùng khi gửi lại.
- Cuối tháng cộng tất cả khoản phụ cấp TikTok hợp lệ của nhân viên.

### 9.4. Lợi nhuận cửa hàng

`Lợi nhuận = Doanh thu - Tổng chi phí`.

Tổng chi phí bao gồm giá vốn/nhập hàng, setup, mặt bằng, điện, nước, wifi, rác, marketing, thuế, khấu hao, lương nhân viên, lương quản lý, phụ cấp nhân viên, thưởng TikTok, thưởng khác và chi phí khác.

## 10. Điều chuyển nhân sự

- Chọn nhân viên, cửa hàng nhận hỗ trợ, ngày bắt đầu/kết thúc, một hoặc nhiều ca, lương giờ, phụ cấp, lý do và người duyệt.
- Mỗi đợt được lưu trong `employee_transfers` với cửa hàng điều đi, cửa hàng nhận, thời gian hiệu lực, ca áp dụng, lương hỗ trợ, phụ cấp, lý do, người tạo và trạng thái.
- Trong thời gian hỗ trợ, nhân viên được đăng nhập và làm việc tại cửa hàng nhận hỗ trợ theo phạm vi được duyệt.
- Khi xử lý mỗi request, backend xác định cửa hàng hiệu lực từ ca đang chạy hoặc đợt điều chuyển còn hiệu lực; trình duyệt không được tự gửi và quyết định cửa hàng truy cập.
- Lương, thưởng, phụ cấp và chi phí nhân sự phát sinh được ghi cho cửa hàng nhận hỗ trợ.
- Lịch sử lương, KPI và công tác tại cửa hàng chính không bị sửa.
- Hết thời gian, hệ thống tự thu hồi quyền cửa hàng hỗ trợ và khôi phục quyền cửa hàng chính.
- Ca đã bắt đầu giữ snapshot cửa hàng nhận và mức lương hỗ trợ cho đến khi kết ca, kể cả khi đợt hỗ trợ hết hạn trong lúc ca đang mở.
- Trạng thái: chờ duyệt, đang hỗ trợ, hoàn thành, đã hủy.

## 11. Cổ tức

- Lợi nhuận sau cùng bằng doanh thu trừ tất cả chi phí của toàn chuỗi.
- Tỷ lệ mặc định: Trương Việt Vi 60%, Phạm Thị Diễm Thúy 40%.
- Cho phép xác nhận chia và khóa kỳ để ngăn chỉnh sửa sau khi chốt.
- Có biểu đồ xu hướng, lịch sử theo tháng/quý/năm, so sánh kỳ trước, xuất Excel và in báo cáo.
- Khung phân tích cuối trang nêu biến động doanh thu, chi phí, biên lợi nhuận và cổ tức từng cổ đông.

## 12. Yêu cầu phi chức năng

- Responsive từ điện thoại 360 px đến màn hình máy tính lớn.
- Giao diện tiếng Việt, tone xanh DORE, font dễ đọc, icon thống nhất.
- Số tiền hiển thị theo định dạng Việt Nam và lưu bằng số nguyên đồng.
- Số tiền lưu bằng `INTEGER/BIGINT` 64-bit của SQLite/D1, không dùng `float`; tỷ lệ và phép chia sử dụng số nguyên/decimal chính xác, cùng một service tài chính và cùng quy tắc làm tròn có unit test.
- Timestamp lưu UTC và hiển thị/tính kỳ theo `Asia/Ho_Chi_Minh`. Thời lượng ca được tính từ giây thực tế; số giờ chỉ là giá trị hiển thị làm tròn hai chữ số.
- Lịch ca luôn lưu `startAt` và `endAt` đầy đủ. Ca qua đêm có `endAt` thuộc ngày kế tiếp, không suy luận chỉ từ giờ trong ngày.
- Bảng lớn hỗ trợ cuộn ngang trên màn hình nhỏ.
- Các API phải validate dữ liệu, phân quyền và chống truy cập chéo cửa hàng.
- Có migration, kiểm thử tự động, nhật ký kiểm toán và quy trình sao lưu/khôi phục.
