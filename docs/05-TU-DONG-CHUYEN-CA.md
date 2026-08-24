# 05. Quy tắc ca làm, overtime và chấm công thực tế

## 1. Mục tiêu

Hệ thống phải ghi nhận đúng thời gian nhân viên thực tế làm việc và không tự biến thời gian làm thêm thành một ca kế tiếp chỉ vì đã vượt giờ kết thúc dự kiến.

Nguyên tắc chính:

`Lịch ca là kế hoạch.`

`Chấm công thực tế là dữ liệu tính công.`

Hai khái niệm này phải được tách riêng.

## 2. Dữ liệu thời gian

Mỗi ca/chấm công phải phân biệt tối thiểu:

- `scheduled_start_at`: giờ bắt đầu theo lịch;
- `scheduled_end_at`: giờ kết thúc theo lịch;
- `actual_start_at` hoặc `started_at`: giờ bắt đầu thực tế;
- `actual_end_at` hoặc `ended_at`: giờ kết thúc thực tế.

Giờ làm dùng để tính lương:

`WORKED_HOURS = actual_end_at - actual_start_at`

Không lấy `scheduled_end_at` thay cho giờ kết ca thực tế.

## 3. Overtime

Nếu nhân viên vẫn làm sau giờ kết thúc dự kiến và chưa bấm **KẾT CA**, hệ thống tiếp tục giữ cùng phiên làm việc.

Ví dụ:

- Ca 3 dự kiến: 17:00–23:00.
- Nhân viên bắt đầu thực tế: 17:05.
- Nhân viên kết ca thực tế: 00:30 ngày hôm sau.

Kết quả đúng:

- scheduled: 17:00–23:00;
- actual: 17:05–00:30;
- thời gian 23:00–00:30 là overtime của phiên làm việc đó;
- không tự động chuyển thành Ca 1 của ngày hôm sau.

## 4. Không auto-rollover theo mốc thời gian

Không được sử dụng quy tắc kiểu:

- quá giờ kết thúc 60 phút thì tự đóng ca cũ;
- tự tạo ca mới;
- tự đổi `current_shift` sang ca kế tiếp.

Nếu code cũ còn `SHIFT_AUTO_ROLLOVER`, grace period hoặc logic chia phiên theo ca kế tiếp thì xem đó là legacy behavior cần loại bỏ/di trú khi sửa module chấm công.

Không xóa dữ liệu lịch sử cũ; chỉ ngừng tạo dữ liệu mới theo logic sai.

## 5. Khi nào được tạo ca/phiên mới

Chỉ tạo ca/phiên mới khi có nghiệp vụ rõ ràng, ví dụ:

- nhân viên đã kết ca trước đó rồi bắt đầu một ca mới;
- quản lý phân công một ca làm khác;
- quản lý tạo ca linh động;
- business rule mới được xác nhận yêu cầu tách phiên.

Không tự suy diễn chỉ từ việc vượt giờ dự kiến.

## 6. Ca linh động

Quản lý được phép:

- tạo ca linh động theo ngày;
- sửa giờ bắt đầu/kết thúc dự kiến;
- điều chỉnh lịch phân ca;
- điều chỉnh chấm công thực tế khi có lý do hợp lệ.

Việc thay đổi lịch ca không được tự ý thay đổi lịch sử thời gian thực tế đã ghi nhận.

## 7. Điều chỉnh chấm công

Khi quản lý sửa giờ thực tế, bắt buộc lưu audit:

- người sửa;
- thời gian sửa;
- giá trị trước;
- giá trị sau;
- lý do;
- bản ghi liên quan.

Sau khi sửa thời gian thuộc kỳ chưa khóa, các số liệu phụ thuộc phải được tính lại đúng thứ tự:

`Worked Hours → Salary → KPI Allocation → Payroll`

## 8. Qua 00:00

Một ca có thể đi qua ngày mới.

Ví dụ 17:00 ngày 24/08 đến 00:30 ngày 25/08 vẫn có thể là một phiên làm việc liên tục.

Không tách phiên chỉ vì đổi ngày.

Việc quy ca vào kỳ/tháng phải dựa trên business rule tài chính được xác nhận và phải có test boundary timezone `Asia/Ho_Chi_Minh`.

## 9. Tính lương và lịch sử

Lương phải lấy giờ thực tế hợp lệ.

Nếu đơn giá giờ có thể thay đổi theo thời gian thì phải snapshot đơn giá được áp dụng cho phiên/kỳ để thay đổi cấu hình sau này không làm sai lịch sử.

Nhân viên đã làm trong kỳ vẫn phải xuất hiện trong payroll kỳ đó dù sau này nghỉ việc, archive hoặc chuyển cửa hàng.

## 10. Kỳ đã khóa

Dữ liệu thuộc kỳ `LOCKED` là immutable.

Không sửa trực tiếp giờ chấm công của kỳ đã khóa.

Nếu cần điều chỉnh, sử dụng adjustment/workflow điều chỉnh có audit thay vì rewrite lịch sử.

## 11. Tiêu chí nghiệm thu

- Làm quá giờ không tự tạo ca kế tiếp.
- Làm qua 00:00 vẫn tính đúng thời gian thực tế.
- Ca linh động không làm sai dữ liệu lịch sử.
- Quản lý chỉnh giờ có audit đầy đủ.
- Thay đổi chấm công ở kỳ chưa khóa cập nhật đúng salary/KPI/payroll.
- Kỳ đã khóa không bị thay đổi trực tiếp.
