# Quy tắc tự động chuyển ca

## Mục tiêu

Khi nhân viên vẫn đang làm việc sau ca hiện tại và chưa bấm **KẾT CA**, hệ thống giữ thời gian chấm công liên tục nhưng tách lịch sử thành từng ca độc lập.

## Quy tắc 60 phút

- Ca 1: 07:00–12:00.
- Ca 2: 12:00–17:00.
- Ca 3: 17:00–23:00.
- Trong 60 phút sau giờ kết thúc, nhân viên vẫn có thể tự kết ca hiện tại.
- Khi thời gian hiện tại vượt quá giờ kết thúc **hơn 60 phút**, hệ thống tự động:
  1. Chốt ca cũ tại đúng giờ kết thúc theo lịch.
  2. Tạo ca kế tiếp có thời gian bắt đầu đúng bằng thời gian kết thúc ca cũ.
  3. Giữ `work_session_id` để nhận biết đây là một chuỗi làm việc liên tục.
  4. Chuyển `current_shift` của nhân viên sang mã ca mới.
  5. Ghi audit log `SHIFT_AUTO_ROLLOVER`.

Ví dụ: nhân viên bắt đầu Ca 1 lúc 07:05 và đến sau 13:00 vẫn chưa kết ca. Hệ thống lưu:

- Ca 1: 07:05–12:00, trạng thái `AUTO_COMPLETED`.
- Ca 2: bắt đầu 12:00 và tiếp tục chạy đến khi nhân viên kết ca hoặc tiếp tục vượt mốc chuyển ca sau.

Không có khoảng trống và không có thời gian bị tính hai lần.

## Điểm kích hoạt kiểm tra

Hệ thống đối soát ca đang hoạt động khi:

- Màn hình nhân viên tải hoặc tự làm mới trạng thái ca.
- Nhân viên xem, tạo, sửa hoặc hủy đơn hàng.
- Quản lý xem lịch sử ca làm.
- Hệ thống tổng hợp báo cáo tài chính và tính lương.

Màn hình nhân viên tự kiểm tra lại mỗi 20 giây và khi tab trình duyệt được mở lại.

## Dữ liệu lịch sử

Mỗi bản ghi `shift_sessions` lưu thêm:

- `shift_name`
- `scheduled_start_at`
- `scheduled_end_at`
- `rollover_from`
- `work_session_id`
- `auto_rolled`

Các trường này giúp báo cáo hiển thị hai ca riêng trong khi vẫn chứng minh chuỗi thời gian làm việc liên tục.
