# DORE CODEX SMART WORKFLOW

Áp dụng mặc định cho mọi task trong repo `mrbengilo/hethongdore`.

Mục tiêu: xử lý nhanh, đúng business rule, tiết kiệm credit/token, không mở rộng phạm vi không cần thiết và tự tăng độ sâu phân tích khi rủi ro tăng.

---

## 1. Task classification

### Level 0 — Trivial

Dùng cho:

- text/typo;
- icon;
- màu sắc;
- spacing;
- label;
- bố cục nhỏ;
- CSS nhỏ;
- responsive cục bộ không ảnh hưởng logic.

Workflow:

`LOCATE → PATCH → QUICK CHECK`

Không audit toàn repo, không đọc DB/Finance nếu không liên quan.

### Level 1 — Low Risk

Dùng cho:

- form đơn giản;
- filter/sort/search;
- modal;
- validation;
- empty/loading state;
- API read-only hoặc frontend behavior nhỏ.

Workflow:

`SEARCH → READ TARGET → IMPACT CHECK → IMPLEMENT → LOCAL VERIFY`

### Level 2 — Medium Risk

Dùng cho:

- CRUD;
- employee/store/order/inventory;
- schema thay đổi nhỏ;
- flow nghiệp vụ cục bộ;
- audit log;
- scheduling không ảnh hưởng lương trực tiếp.

Workflow:

`SEARCH → DEPENDENCY TRACE → PLAN → IMPLEMENT → LOCAL TEST → REGRESSION`

### Level 3 — High/Critical Risk

Bắt buộc cho:

- doanh thu;
- chi phí;
- dòng tiền;
- lương;
- thưởng;
- phụ cấp;
- ứng lương;
- chấm công;
- tổng giờ làm;
- KPI;
- lợi nhuận;
- chi phí cuối kỳ;
- final profit;
- cổ tức/chia lợi nhuận;
- payroll/chốt kỳ/khóa kỳ;
- historical snapshot;
- auth/permission quan trọng;
- migration tài chính.

Workflow:

`READ RULES → DISCOVER → TRACE SOURCE OF TRUTH → RISK ANALYSIS → PLAN → IMPLEMENT → MODULE TEST → DEPENDENCY REGRESSION → BUILD → SELF REVIEW → REPORT`

Nếu task đang ở Level 0–2 nhưng phát hiện side effect tài chính, lịch sử, quyền hoặc nguy cơ mất dữ liệu thì tự nâng lên Level 3.

---

## 2. Credit efficiency rules

1. Search trước, read sau.
2. Chỉ đọc file match thật sự.
3. File lớn chỉ đọc function/component liên quan.
4. Không đọc lại file đã có context trừ khi file vừa thay đổi.
5. Không audit module unrelated.
6. Không chạy full suite nhiều lần.
7. Không build sau từng patch nhỏ.
8. Không viết plan dài cho task nhỏ.
9. Không refactor ngoài scope nếu không cần.
10. Reuse shared logic/source of truth.
11. Batch các thay đổi liên quan.
12. Test dependency theo risk, không test ngẫu nhiên.

---

## 3. Search-first strategy

Ví dụ task về final profit:

Search trước các symbol:

- `finalProfit`
- `profitAfterKpi`
- `distributableProfit`
- `calculateStoreFinance`

Sau đó mở đúng file match.

Ví dụ task về payroll:

Search:

- `payroll`
- `salary`
- `workedHours`
- `shift_sessions`

Không mở toàn bộ repo nếu không cần.

---

## 4. Source of truth check

Trước khi thêm logic mới phải trả lời nội bộ:

- Dữ liệu được tạo ở đâu?
- Dữ liệu gốc nằm ở đâu?
- Công thức hiện được tính ở đâu?
- Có nơi nào khác đang tính cùng giá trị không?

Nếu có duplicate logic, ưu tiên gom về shared domain/business layer thay vì copy thêm.

---

## 5. Implementation order

Nếu task chạm nhiều layer:

`DB → Domain/Business Logic → API → Frontend State → UI → Tests`

Không sửa UI để che lỗi backend.

Không đưa business formula vào component nếu đã có hoặc nên có shared engine.

---

## 6. Finance safety gate

Mọi thay đổi tài chính phải trace chuỗi:

`Revenue`

→ `Fixed Expense`

→ `Variable Expense`

→ `Inventory Cost`

→ `Shipping Cost`

→ `Employee Salary`

→ `Manager Salary`

→ `Manual Bonus`

→ `Allowance`

→ `Operating Profit`

→ `Employee KPI`

→ `Manager KPI`

→ `Profit After KPI`

→ `Month-End Expense`

→ `Final Profit`

→ `Distributable Profit`

Các invariant:

- `Cashflow != Expense`
- một nghiệp vụ chỉ được tính một lần vào profit;
- `Operating Profit != Final Profit`;
- `Profit After KPI != Final Profit`;
- `Final Profit = Profit After KPI - Month-End Expense`;
- Final Profit có thể âm;
- `Distributable Profit = max(0, Final Profit)`;
- chỉ Distributable Profit được dùng để chia lợi nhuận/cổ tức.

Nếu sửa Expense, regression tối thiểu:

`Operating Profit → KPI → Profit After KPI → Final Profit → Report/Dividend`

Nếu sửa Final Profit, regression tối thiểu:

`Report → Dividend/Distribution`

---

## 7. Cashflow safety

Phân biệt:

- Expense = nghiệp vụ ảnh hưởng P&L/profit.
- Cashflow = tiền thực tế vào/ra.

Nếu một expense tạo cashflow, phải liên kết bằng `sourceType/sourceId` hoặc cơ chế tương đương.

Finance Engine không được cộng lại expense từ cashflow nếu expense nguồn đã được tính.

---

## 8. Attendance safety gate

Task chấm công trace:

`Shift → Actual Start/End → Worked Hours → Salary → KPI Allocation → Payroll`

Phân biệt:

- scheduledStartAt;
- scheduledEndAt;
- actualStartAt;
- actualEndAt.

`Worked Hours` phải dựa trên thời gian thực tế đã xác nhận.

Không tự chuyển overtime thành ca khác nếu business rule mới nhất không yêu cầu.

Nếu sửa workedHours, regression tối thiểu:

`Salary → KPI Allocation → Payroll`

---

## 9. Payroll and historical safety

Nhân viên đã làm trong kỳ vẫn phải được tính payroll của kỳ đó dù sau này:

- archive;
- nghỉ việc;
- chuyển cửa hàng.

Kỳ `LOCKED` là immutable.

Không tính lại kỳ locked từ:

- hourly rate hiện tại;
- manager salary hiện tại;
- KPI config hiện tại;
- employee status hiện tại;
- tỷ lệ chia lợi nhuận hiện tại.

Sử dụng snapshot của kỳ.

Nếu cần sửa sau lock, dùng adjustment có audit.

---

## 10. Database safety gate

Nếu task thay schema:

- đọc schema hiện tại;
- đọc migration liên quan;
- kiểm tra backwards compatibility;
- kiểm tra dữ liệu cũ;
- default/nullability/backfill;
- index nếu cần;
- tạo migration mới;
- không sửa migration production cũ;
- không xóa dữ liệu nếu không có yêu cầu rõ ràng và migration an toàn.

---

## 11. Permission safety

API mới hoặc API sửa phải kiểm tra:

- authentication;
- role;
- store scope;
- ownership nếu có;
- manager vs employee.

Không coi việc ẩn button trên UI là đủ bảo mật.

---

## 12. Audit rules

Các thay đổi quan trọng cần audit khi nghiệp vụ yêu cầu:

- sửa chấm công/ca;
- sửa/xóa đơn;
- sửa/xóa expense;
- bonus;
- allowance;
- salary advance;
- month-end expense;
- payroll;
- confirm/pay/lock period.

Audit nên lưu tối thiểu:

- actor;
- action;
- entity;
- before;
- after;
- reason;
- timestamp.

---

## 13. Mobile workflow

Task UI chỉ audit màn hình bị ảnh hưởng trước.

Test tối thiểu:

- 360px;
- 390px;
- 430px;
- desktop.

Nếu thay shared layout mới mở rộng kiểm tra các màn hình khác.

Không để:

- overflow toàn page;
- text/số tiền bị cắt;
- modal vượt viewport;
- table làm vỡ layout;
- fixed/sticky element che action.

---

## 14. Minimum change principle

Task nhỏ → patch nhỏ.

Chỉ refactor khi:

- logic duplicate;
- source of truth bị phân tán;
- code hiện tại gây bug;
- refactor cần thiết để bảo toàn business rule.

Không đổi theme, cấu trúc module hoặc API unrelated chỉ vì tiện tay.

---

## 15. Test strategy by level

### L0

- local render/syntax check;
- lint nếu nhanh.

### L1

- lint;
- typecheck;
- test liên quan nếu có.

### L2

- relevant unit test;
- relevant integration test;
- dependency regression;
- lint/typecheck.

### L3

- module unit tests;
- integration tests;
- dependency regression;
- lint;
- typecheck;
- production build.

Không chạy full suite sau mỗi patch nhỏ.

---

## 16. Test failure handling

Nếu fail:

1. xác định lỗi do patch mới hay pre-existing;
2. nếu do patch, sửa trước khi hoàn thành;
3. nếu unrelated/pre-existing, ghi rõ và không tự mở rộng scope nếu task vẫn có thể verify an toàn.

Không tuyên bố pass nếu mandatory check do patch vẫn fail.

---

## 17. Stop conditions

Dừng fast path và nâng phân tích khi phát hiện:

- nguy cơ mất dữ liệu;
- double-count;
- source of truth không rõ;
- cùng financial value được tính ở nhiều nơi;
- kỳ locked bị thay đổi;
- migration nguy hiểm;
- permission bypass;
- business rule mâu thuẫn.

Phải xử lý root cause/dependency trước.

---

## 18. Decision matrix

- UI text/style → L0.
- UI + simple state/API read → L1.
- CRUD/schema/flow → L2.
- Money/payroll/attendance/history/permission → L3.
- Phát hiện side effect tài chính → nâng L3.
- Chỉ sửa responsive local → không audit Finance.
- Sửa workedHours → regression Salary + KPI + Payroll.
- Sửa Expense → regression Profit + KPI + Final Profit + Dividend.
- Sửa Final Profit → regression Report + Dividend.

---

## 19. Task execution template

Mỗi task tự xử lý nội bộ theo:

### CLASSIFY

Chọn Level 0–3.

### LOCATE

Search đúng symbol/file/source of truth.

### IMPACT

Trace dependency thực sự, không mở rộng ngẫu nhiên.

### PLAN

Chỉ viết plan nếu L2/L3 hoặc task nhiều bước.

### PATCH

Thay đổi nhỏ nhất đúng kiến trúc.

### VERIFY

Test local feature.

### REGRESSION

Test dependency theo risk.

### REPORT

Báo cáo ngắn theo level.

---

## 20. Report format

### L0/L1

- Done
- Files changed
- Check result

### L2

- Done
- Files changed
- Business impact
- Tests
- Risks

### L3

- Completed
- Root cause
- Business rules verified
- Files changed
- DB changes
- Tests
- Regression
- Remaining risks

Không xuất chain-of-thought.

---

## 21. Default execution behavior

Nếu yêu cầu đủ rõ:

- tự thực hiện;
- không hỏi lại chỉ để xin phép tiếp tục;
- không dừng giữa chừng vì task dài;
- tự chọn mức phân tích;
- tự nâng level khi phát hiện rủi ro;
- báo cáo khi hoàn thành phạm vi task.

Small task → small analysis.

High-risk task → deep analysis.

Search first, read selectively.

Do not spend credit proving things unrelated to the task.

Fast when safe, thorough when necessary.
