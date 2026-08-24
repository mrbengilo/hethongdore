# 06. Quy tắc chuẩn tài chính, lương, lợi nhuận và chốt kỳ

Tài liệu này là nguồn business rule chuẩn cho các phần tài chính quan trọng của DORE.

Nếu tài liệu cũ mâu thuẫn với tài liệu này thì ưu tiên tài liệu này, trừ khi có yêu cầu mới hơn được người dùng xác nhận.

## 1. One source of truth

Mọi màn hình và API phải dùng cùng một Finance Engine/business layer.

Không được tự tính lại profit, KPI hoặc distributable profit ở UI, report hay dividend bằng công thức riêng.

## 2. Kỳ và timezone

Timezone chuẩn: `Asia/Ho_Chi_Minh`.

Kỳ tháng từ 00:00:00 ngày 01 đến trước 00:00:00 ngày 01 tháng kế tiếp.

## 3. Doanh thu

`GROSS_REVENUE` = tổng đơn hợp lệ ở trạng thái hoàn thành trong kỳ.

Không tính đơn canceled/void/deleted/test hoặc ngoài kỳ.

## 4. Chi phí trước KPI

Phải tách và cộng đúng:

- `FIXED_EXPENSE`: tổng tất cả chi phí cố định hợp lệ trong kỳ, không chỉ lấy bản ghi mới nhất;
- `VARIABLE_EXPENSE`: tổng chi phí phát sinh hợp lệ;
- `INVENTORY_COST`: tiền hàng nhập;
- `INVENTORY_SHIPPING_COST`: vận chuyển nhập hàng, không double-count;
- `EMPLOYEE_SALARY`;
- `MANAGER_SALARY`;
- `MANUAL_EMPLOYEE_BONUS`;
- `EMPLOYEE_ALLOWANCE`.

`Cashflow != Expense`.

Nếu một expense có dòng tiền tương ứng, cashflow phải liên kết bằng source reference và không được làm profit giảm lần thứ hai.

## 5. Lương

`EMPLOYEE_SALARY = WORKED_HOURS × HOURLY_RATE_APPLIED`

Giờ làm lấy từ thời gian thực tế hợp lệ.

Đơn giá áp dụng cần snapshot/version theo thời điểm hoặc kỳ để không làm sai lịch sử.

Nhân viên đã làm trong kỳ vẫn phải được tính dù sau đó nghỉ/archive/chuyển cửa hàng.

Lương quản lý và các mức phụ cấp không hard-code trực tiếp trong Finance Engine; lấy từ cấu hình có hiệu lực và snapshot khi khóa kỳ.

## 6. Thưởng và phụ cấp

Mỗi khoản phải truy được nguồn gốc, loại, nhân viên, cửa hàng, kỳ, người tạo, thời gian và ghi chú.

Phụ cấp TikTok phải dùng config thay vì hard-code và snapshot số tiền áp dụng.

## 7. Ứng lương

Ứng lương là khoản trả trước, không được tính lại thành expense lần hai nếu payroll expense đã ghi nhận toàn bộ lương.

`NET_PAYABLE = TOTAL_EARNED - SALARY_ADVANCE`

Mọi khoản ứng phải gắn nhân viên, cửa hàng, kỳ, số tiền, người tạo và audit.

## 8. Lợi nhuận hoạt động

`OPERATING_PROFIT = GROSS_REVENUE - FIXED_EXPENSE - VARIABLE_EXPENSE - INVENTORY_COST - INVENTORY_SHIPPING_COST - EMPLOYEE_SALARY - MANAGER_SALARY - MANUAL_EMPLOYEE_BONUS - EMPLOYEE_ALLOWANCE`

Nếu âm thì giữ số âm.

## 9. KPI

KPI phải nằm trong module riêng và dùng cùng `OPERATING_PROFIT`.

Nếu đang dùng threshold hiện hành thì có thể giữ tạm nhưng phải cấu hình hóa để đổi dễ dàng.

Manager KPI hiện hành:

`MANAGER_KPI = 2% × OPERATING_PROFIT` khi `OPERATING_PROFIT > 0`, ngược lại bằng 0.

Employee KPI phải dùng cùng source of truth và không tự tính riêng ở UI.

## 10. Lợi nhuận sau KPI

`PROFIT_AFTER_KPI = OPERATING_PROFIT - EMPLOYEE_KPI_TOTAL - MANAGER_KPI`

Nếu âm thì giữ số âm.

## 11. Chi phí cuối kỳ hàng tháng

Bổ sung module `MONTH_END_EXPENSE` cho quản lý nhập trước khi xác định lợi nhuận cuối cùng.

Có thể có nhiều khoản trong một tháng.

Mỗi khoản cần tối thiểu:

- id;
- storeId;
- month;
- title/category;
- amount;
- note;
- createdBy;
- createdAt;
- updatedAt;
- status;
- audit history.

Ví dụ: dự phòng, hao hụt, điều chỉnh tồn kho, chi phí quản trị, khấu trừ cuối kỳ, chi phí bổ sung khác.

`MONTH_END_EXPENSE = SUM(tất cả khoản hợp lệ trong kỳ)`

Trước khi khóa kỳ, quản lý được tạo/sửa/xóa có audit. Sau khi khóa, không sửa trực tiếp.

## 12. Lợi nhuận sau cùng

`FINAL_PROFIT = PROFIT_AFTER_KPI - MONTH_END_EXPENSE`

Đây là lợi nhuận sau cùng chính thức của tháng.

Final Profit có thể âm.

Không dùng `Math.max(0, finalProfit)` để che số lỗ.

## 13. Lợi nhuận được phép chia

`DISTRIBUTABLE_PROFIT = max(0, FINAL_PROFIT)`

Chỉ `DISTRIBUTABLE_PROFIT` được dùng cho chia lợi nhuận/cổ tức.

Không dùng Revenue, Operating Profit hoặc Profit After KPI để chia.

## 14. Chuỗi tính chuẩn

`Revenue → Fixed Expense → Variable Expense → Inventory → Shipping → Salary → Bonus → Allowance → Operating Profit → Employee KPI → Manager KPI → Profit After KPI → Month-End Expense → Final Profit → Distributable Profit`

Bất kỳ thay đổi tài chính nào cũng phải regression các dependency phía sau có liên quan.

## 15. Workflow chốt kỳ

Trạng thái chuẩn:

`DRAFT → CALCULATED → RECONCILING → CONFIRMED → PAID → LOCKED`

### DRAFT

Kỳ đang hoạt động, nhập liệu bình thường.

### CALCULATED

Sau khi hết kỳ, hệ thống tổng hợp số liệu. Có thể tự chuyển từ DRAFT sang CALCULATED lúc 00:00 ngày 01 tháng kế tiếp nhưng không auto-lock.

### RECONCILING

Quản lý đối soát doanh thu, chi phí, chấm công, lương, thưởng, phụ cấp, KPI, ứng lương và chi phí cuối kỳ. Nếu sai được sửa dữ liệu nguồn hợp lệ và recalculate.

### CONFIRMED

Quản lý xác nhận số liệu và tạo snapshot.

### PAID

Xác nhận đã chi lương/thưởng; lưu thời gian và người xác nhận.

### LOCKED

Khóa kỳ. Dữ liệu lịch sử và snapshot là immutable.

Không được mở kỳ rồi rewrite dữ liệu cũ theo cách làm mất dấu lịch sử. Nếu cần điều chỉnh, dùng `ADJUSTMENT` hoặc workflow điều chỉnh có audit.

## 16. Snapshot tối thiểu

Khi confirmed/locked phải lưu đủ dữ liệu để kỳ cũ không phụ thuộc config hiện tại, tối thiểu:

- grossRevenue;
- fixedExpense;
- variableExpense;
- inventoryCost;
- shippingCost;
- employeeSalary;
- managerSalary;
- manualBonus;
- allowance;
- salaryAdvance;
- totalHours;
- employeeKpiTotal;
- managerKpi;
- operatingProfit;
- profitAfterKpi;
- monthEndExpense;
- finalProfit;
- distributableProfit;
- payroll rows;
- config/version áp dụng;
- confirmed/paid/locked timestamps và actors.

## 17. Audit

Các thay đổi ảnh hưởng tiền hoặc lịch sử phải ghi actor, action, entity, before, after, reason, timestamp.

## 18. Regression bắt buộc

- Sửa chấm công → kiểm tra workedHours, salary, KPI allocation, payroll.
- Sửa expense → kiểm tra operatingProfit, KPI, finalProfit, report, dividend.
- Sửa KPI → kiểm tra profitAfterKpi, finalProfit, dividend.
- Sửa month-end expense → kiểm tra finalProfit, distributableProfit, report, dividend.
- Sửa finalProfit → kiểm tra report và dividend.

## 19. Ví dụ chuẩn

Revenue = 100.000.000

Tổng chi phí trước KPI = 70.000.000

Operating Profit = 30.000.000

Employee KPI = 1.500.000

Manager KPI = 600.000

Profit After KPI = 27.900.000

Month-End Expense = 2.900.000

Final Profit = 25.000.000

Distributable Profit = 25.000.000

Chỉ 25.000.000 được chuyển sang chia lợi nhuận/cổ tức.

Nếu Final Profit = -1.000.000 thì vẫn hiển thị -1.000.000 nhưng Distributable Profit = 0.
