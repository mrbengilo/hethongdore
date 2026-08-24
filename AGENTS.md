# AGENTS.md — DORE Codex Operating Rules

Repo: `mrbengilo/hethongdore`

Mục tiêu: mọi Codex/AI agent xử lý task DORE nhanh, đúng phạm vi, ít tốn credit, nhưng tự tăng mức phân tích khi task có rủi ro.

## 1. Thứ tự ưu tiên nguồn sự thật

Khi có mâu thuẫn, ưu tiên theo thứ tự:

1. Yêu cầu mới nhất được người dùng xác nhận trong task hiện tại.
2. Business rule mới nhất đã được cập nhật trong tài liệu repo.
3. `AGENTS.md` và `docs/CODEX_WORKFLOW.md` về cách thực thi.
4. Các tài liệu cũ trong `docs/`.
5. Hành vi code hiện tại.

Không mặc định coi code hiện tại là business rule đúng nếu tài liệu mới hơn đã thay đổi.

## 2. Workflow bắt buộc

Mọi task phải tự phân loại trước khi làm:

- **L0 — Trivial:** text, typo, icon, CSS nhỏ, label, spacing.
- **L1 — Low:** UI state đơn giản, filter, sort, form nhỏ, validation, API read-only.
- **L2 — Medium:** CRUD, schema nhỏ, employee/store/order/inventory, flow nghiệp vụ cục bộ.
- **L3 — High/Critical:** finance, payroll, attendance, shift hours, cashflow, profit, KPI, bonus, allowance, salary advance, period close, locked history, auth/permission, financial migrations.

Quy trình theo level:

- L0: `LOCATE → PATCH → QUICK CHECK`
- L1: `SEARCH → READ TARGET → IMPACT CHECK → IMPLEMENT → LOCAL VERIFY`
- L2: `SEARCH → TRACE DEPENDENCY → PLAN → IMPLEMENT → TARGETED TEST → REGRESSION`
- L3: `READ RULES → DISCOVER → TRACE SOURCE OF TRUTH → RISK ANALYSIS → PLAN → IMPLEMENT → TEST → REGRESSION → BUILD → SELF REVIEW`

Nếu đang làm task L0–L2 nhưng phát hiện rủi ro tài chính, lịch sử, permission, data loss hoặc duplicate business logic thì **tự nâng lên L3**.

Chi tiết đầy đủ: `docs/CODEX_WORKFLOW.md`.

## 3. Tối ưu credit/token

- Search trước, read sau.
- Không đọc toàn repo nếu task không cần.
- Không đọc toàn file lớn nếu chỉ cần một function/component.
- Không đọc lại file đã có context trừ khi file vừa thay đổi.
- Không audit module không liên quan.
- Không chạy full test suite sau từng patch nhỏ.
- Không build nhiều lần; build cuối L3 hoặc khi cần xác nhận integration.
- Không viết plan dài cho L0/L1.
- Không refactor ngoài phạm vi nếu không cần để sửa root cause.
- Ưu tiên reuse source of truth hiện có thay vì copy logic.

## 4. Quy tắc kiến trúc

- Fix root cause, không vá symptom.
- Một business value chỉ có một source of truth.
- Không copy công thức tài chính sang UI.
- Nếu thay đổi nhiều layer, ưu tiên: `DB → domain/business logic → API → frontend state → UI → tests`.
- Không sửa migration production cũ; tạo migration mới.
- Không làm mất dữ liệu.
- Backend phải enforce permission; không chỉ ẩn nút ở UI.

## 5. Finance Safety Gate

Bất kỳ task nào ảnh hưởng tiền phải trace đủ các dependency phía sau:

`Revenue → Fixed Expense → Variable Expense → Inventory → Shipping → Salary → Bonus → Allowance → Operating Profit → Employee KPI → Manager KPI → Profit After KPI → Month-End Expense → Final Profit → Distributable Profit`

Các invariant bắt buộc:

- `Cashflow != Expense`
- Không double-count tiền.
- `Operating Profit != Final Profit`
- `Profit After KPI != Final Profit`
- `Final Profit = Profit After KPI - Month-End Expense`
- `Distributable Profit = max(0, Final Profit)`
- Chỉ `Distributable Profit` được dùng để chia lợi nhuận/cổ tức.
- Final Profit được phép âm; không dùng `Math.max(0, finalProfit)` để che lỗ.

## 6. Attendance/Payroll Safety Gate

Task liên quan chấm công phải trace:

`Shift → Actual Start/End → Worked Hours → Salary → KPI Allocation → Payroll`

Phân biệt rõ giờ dự kiến và giờ thực tế.

Không tự biến overtime thành ca khác chỉ vì quá giờ dự kiến nếu business rule hiện hành không yêu cầu.

Nhân viên đã làm trong kỳ vẫn phải xuất hiện trong payroll lịch sử dù sau đó archive/nghỉ/chuyển cửa hàng.

## 7. Historical Safety

Kỳ `LOCKED` là immutable.

Không tính lại kỳ đã khóa bằng cấu hình hiện tại.

Nếu cần điều chỉnh lịch sử, dùng adjustment/workflow điều chỉnh có audit; không rewrite snapshot.

## 8. Audit bắt buộc

Các thay đổi quan trọng phải có actor, action, before, after, reason, timestamp khi business flow yêu cầu, đặc biệt:

- chấm công/ca;
- đơn hàng;
- chi phí;
- thưởng/phụ cấp;
- ứng lương;
- chi phí cuối kỳ;
- payroll;
- chốt/khóa kỳ.

## 9. Responsive rule

Task UI phải kiểm tra tối thiểu 360px, 390px, 430px và desktop nếu màn hình bị ảnh hưởng.

Không để overflow toàn trang, text/số tiền bị cắt, modal vượt viewport hoặc table phá layout.

## 10. Test theo mức độ

- L0: quick local check; lint nếu nhanh.
- L1: lint/typecheck + test liên quan nếu có.
- L2: unit/integration liên quan + dependency regression + typecheck/lint.
- L3: module tests + integration + dependency regression + typecheck + lint + production build.

Không nói task hoàn thành nếu lỗi bắt buộc do patch vẫn còn.

Lỗi unrelated có sẵn phải ghi rõ `pre-existing issue`, không tự mở rộng scope nếu không cần.

## 11. Stop conditions

Dừng fast path và nâng mức phân tích khi phát hiện:

- nguy cơ mất dữ liệu;
- double-count;
- source of truth không rõ;
- duplicate finance logic;
- sửa kỳ locked;
- migration nguy hiểm;
- permission bypass;
- business rule mâu thuẫn.

Xử lý dependency/root cause trước rồi mới tiếp tục.

## 12. Báo cáo

L0/L1: `Done / Files changed / Check result`.

L2: `Done / Files changed / Business impact / Tests / Risks`.

L3: `Completed / Root cause / Business rules / Files changed / DB changes / Tests / Regression / Remaining risks`.

Báo cáo ngắn, không kể lại chain-of-thought.

## 13. Mặc định thực thi

Nếu yêu cầu đã rõ, tự thực hiện đến khi hoàn thành phạm vi task. Không hỏi lại chỉ để xin phép tiếp tục.

Small task → small analysis.

High-risk task → deep analysis.

Fast when safe, thorough when necessary.
