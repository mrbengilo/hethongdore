# AGENTS.md — DORE Codex Operating Rules

Repo: `mrbengilo/hethongdore`

Mục tiêu: mọi Codex/AI agent xử lý task DORE nhanh, đúng phạm vi, ít tốn credit, tự tăng mức phân tích khi rủi ro tăng và luôn đưa ra kết quả có bằng chứng.

## 1. Hồ sơ chủ dự án và mức chất lượng mong đợi

Chủ dự án là:

- chuyên gia lập trình với hơn 10 năm kinh nghiệm;
- thành thạo các ngôn ngữ, kiến trúc, framework, nền tảng và công nghệ hiện đại;
- chuyên gia UI/UX với hơn 10 năm kinh nghiệm;
- có khả năng review sâu về architecture, business logic, security, database, performance, clean code và trải nghiệm người dùng.

Codex phải giao tiếp và thực thi ở mức senior/staff engineering:

- không giải thích hời hợt;
- không đơn giản hóa sai bản chất kỹ thuật;
- nêu rõ trade-off và lý do chọn giải pháp;
- ưu tiên correctness, data integrity, security, maintainability, testability và usability;
- không che giấu phần chưa xác minh hoặc rủi ro còn lại.

Tiêu chuẩn chi tiết: `docs/CODEX_ENGINEERING_STANDARDS.md`.

## 2. Model, reasoning và speed bắt buộc

Project-scoped defaults nằm tại `.codex/config.toml`:

- model mặc định: `gpt-5.6-sol`;
- reasoning mặc định: `high`;
- speed/service tier mặc định: `fast`;
- multi-agent được bật.

Quy tắc nâng mức:

- **HIGH:** mặc định cho mọi task.
- **XHIGH:** dùng cho task khó, root cause chưa rõ, cross-module, finance/payroll/attendance, auth/permission, migration, concurrency, idempotency, dữ liệu lịch sử hoặc rủi ro mất dữ liệu/sai tiền.
- **ULTRA:** dùng khi task lớn có nhiều workstream độc lập thực sự hưởng lợi từ multi-agent, ví dụ audit lớn backend + database + frontend + tests + security.

Không dùng Ultra cho task text/CSS nhỏ hoặc một function đơn giản.

Ultra là chế độ phối hợp nhiều agent, không được mô tả sai thành một giá trị `model_reasoning_effort`.

Nếu runtime/session không hỗ trợ model, xhigh, Ultra hoặc Fast theo yêu cầu:

1. dùng cấu hình mạnh nhất thực tế có thể chọn;
2. không tuyên bố đã dùng chế độ chưa được bật;
3. ghi rõ giới hạn trong báo cáo nếu giới hạn đó ảnh hưởng độ tin cậy hoặc phạm vi kiểm chứng.

Reasoning cao không đồng nghĩa với đọc toàn repo. Vẫn phải search trước, đọc chọn lọc và test đúng dependency để tiết kiệm credit.

## 3. Evidence-First — không bịa đặt, không phán đoán vô căn cứ

Codex không được:

- bịa root cause;
- tưởng tượng schema, API, route, permission, business rule hoặc runtime behavior;
- biến giả thuyết thành sự thật;
- tuyên bố test/build/deploy/production verification pass khi chưa có output thực tế;
- dùng dữ liệu demo rồi trình bày như dữ liệu thật;
- kết luận từ một test không bao phủ flow cần kiểm tra.

Trước khi kết luận phải phân biệt nội bộ:

- **FACTS:** đã thấy trực tiếp trong code, schema, test, log, runtime hoặc tài liệu chính thức;
- **EVIDENCE:** file, symbol, query, output, reproduction hoặc test hỗ trợ kết luận;
- **HYPOTHESES:** giả thuyết đang kiểm tra;
- **UNKNOWNS:** phần chưa đủ dữ liệu;
- **CONCLUSION:** chỉ đưa ra khi evidence đủ mạnh.

Mọi root cause phải có logic truy vết rõ ràng. Nếu chưa đủ bằng chứng, phải nói rõ chưa xác minh thay vì đoán.

## 4. Thứ tự ưu tiên nguồn sự thật

Khi có mâu thuẫn, ưu tiên theo thứ tự:

1. Yêu cầu mới nhất được người dùng xác nhận trong task hiện tại.
2. Business rule mới nhất đã được cập nhật trong tài liệu repo.
3. `AGENTS.md`, `docs/CODEX_WORKFLOW.md` và `docs/CODEX_ENGINEERING_STANDARDS.md` về cách thực thi.
4. Các tài liệu cũ trong `docs/`.
5. Hành vi code hiện tại.

Không mặc định coi code hiện tại là business rule đúng nếu tài liệu mới hơn đã thay đổi.

## 5. Workflow bắt buộc

Mọi task phải tự phân loại trước khi làm:

- **L0 — Trivial:** text, typo, icon, CSS nhỏ, label, spacing.
- **L1 — Low:** UI state đơn giản, filter, sort, form nhỏ, validation, API read-only.
- **L2 — Medium:** CRUD, schema nhỏ, employee/store/order/inventory, flow nghiệp vụ cục bộ.
- **L3 — High/Critical:** finance, payroll, attendance, shift hours, cashflow, profit, bonus, allowance, salary advance, period close, locked history, auth/permission, financial migrations.

Quy trình theo level:

- L0: `LOCATE → PATCH → QUICK CHECK`
- L1: `SEARCH → READ TARGET → IMPACT CHECK → IMPLEMENT → LOCAL VERIFY`
- L2: `SEARCH → TRACE DEPENDENCY → PLAN → IMPLEMENT → TARGETED TEST → REGRESSION`
- L3: `READ RULES → DISCOVER → TRACE SOURCE OF TRUTH → RISK ANALYSIS → PLAN → IMPLEMENT → TEST → REGRESSION → BUILD → SELF REVIEW`

Nếu đang làm task L0–L2 nhưng phát hiện rủi ro tài chính, lịch sử, permission, data loss hoặc duplicate business logic thì tự nâng lên L3 và nâng reasoning lên xhigh/Ultra khi phù hợp.

Chi tiết đầy đủ: `docs/CODEX_WORKFLOW.md`.

## 6. Quy trình phân tích và chọn giải pháp

Mỗi task phải đi theo logic:

`Understand request → Classify risk → Locate source of truth → Reproduce/inspect → Identify root cause → Evaluate solutions → Select optimal solution → Implement minimal correct change → Verify → Regression → Report`

Trước khi sửa phải xác định:

- nhu cầu/lỗi thực sự;
- nơi dữ liệu hoặc behavior được tạo;
- source of truth;
- dependency phía trước và phía sau;
- root cause và evidence;
- phương án khả thi cùng trade-off;
- giải pháp tối ưu theo correctness, simplicity, maintainability, performance, security và UX;
- test chứng minh thay đổi đúng.

Không gọi giải pháp là “tối ưu” nếu chưa đánh giá trade-off chính.

## 7. Tối ưu credit/token

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
- Batch các thay đổi liên quan và test theo dependency thực tế.

## 8. Quy tắc kiến trúc và clean code

- Fix root cause, không vá symptom.
- Một business value chỉ có một source of truth.
- Không copy công thức tài chính sang UI.
- Nếu thay đổi nhiều layer, ưu tiên: `DB → domain/business logic → API → frontend state → UI → tests`.
- Không sửa migration production cũ; tạo migration mới.
- Không làm mất dữ liệu.
- Backend phải enforce permission; không chỉ ẩn nút ở UI.
- Tên biến/function/component phải rõ theo domain.
- Business logic tách khỏi UI.
- Type chặt chẽ và validation tại boundary.
- Tránh duplicate, nested logic không cần thiết và abstraction chưa có nhu cầu.
- Comment giải thích “why”, không lặp lại “what” hiển nhiên.
- Không để dead code, debug log hoặc dữ liệu demo.
- Không catch lỗi rồi im lặng.
- Không thay đổi behavior unrelated.
- Ưu tiên minimal correct change, backward compatibility, idempotency và transaction/atomicity khi nghiệp vụ yêu cầu.

## 9. Finance Safety Gate

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

## 10. Attendance/Payroll Safety Gate

Task liên quan chấm công phải trace:

`Shift → Actual Start/End → Worked Hours → Salary → KPI Allocation → Payroll`

Phân biệt rõ giờ dự kiến và giờ thực tế.

Không tự biến overtime thành ca khác chỉ vì quá giờ dự kiến nếu business rule hiện hành không yêu cầu.

Nhân viên đã làm trong kỳ vẫn phải xuất hiện trong payroll lịch sử dù sau đó archive/nghỉ/chuyển cửa hàng.

## 11. Historical Safety

Kỳ `LOCKED` là immutable.

Không tính lại kỳ đã khóa bằng cấu hình hiện tại.

Nếu cần điều chỉnh lịch sử, dùng adjustment/workflow điều chỉnh có audit; không rewrite snapshot.

## 12. Audit bắt buộc

Các thay đổi quan trọng phải có actor, action, before, after, reason, timestamp khi business flow yêu cầu, đặc biệt:

- chấm công/ca;
- đơn hàng;
- chi phí;
- thưởng/phụ cấp;
- ứng lương;
- chi phí cuối kỳ;
- payroll;
- chốt/khóa kỳ.

## 13. UI/UX senior standard

Mọi task UI phải được xử lý ở chất lượng chuyên gia UI/UX hơn 10 năm kinh nghiệm:

- hierarchy và luồng thao tác rõ;
- primary/secondary action phân biệt rõ;
- typography, spacing, icon và màu sắc đồng bộ;
- ưu tiên design token/shared component thay vì CSS rải rác;
- đủ loading, empty, error, disabled và success state;
- form có label, validation và feedback rõ;
- accessibility, contrast và vùng bấm hợp lý;
- không hy sinh usability chỉ để giao diện đẹp.

Task UI phải kiểm tra tối thiểu 360px, 390px, 430px và desktop nếu màn hình bị ảnh hưởng; thêm tablet khi shared layout hoặc flow phức tạp.

Không để overflow toàn trang, text/số tiền bị cắt, modal vượt viewport, table phá layout hoặc fixed/sticky element che action.

## 14. Test theo mức độ

- L0: quick local check; lint nếu nhanh.
- L1: lint/typecheck + test liên quan nếu có.
- L2: unit/integration liên quan + dependency regression + typecheck/lint.
- L3: module tests + integration + dependency regression + typecheck + lint + production build.

Bằng chứng xác minh phải đúng với flow cần kiểm tra: static inspection, unit/integration test, DB/migration validation, browser reproduction, logs hoặc production verification tùy task.

Không nói task hoàn thành nếu lỗi bắt buộc do patch vẫn còn.

Lỗi unrelated có sẵn phải ghi rõ `pre-existing issue`, không tự mở rộng scope nếu không cần.

Nếu không thể chạy một check bắt buộc, báo rõ check chưa chạy, lý do và rủi ro còn lại.

## 15. Stop conditions

Dừng fast path và nâng mức phân tích khi phát hiện:

- nguy cơ mất dữ liệu;
- double-count;
- source of truth không rõ;
- duplicate finance logic;
- sửa kỳ locked;
- migration nguy hiểm;
- permission bypass;
- business rule mâu thuẫn;
- root cause chưa đủ evidence.

Xử lý dependency/root cause trước rồi mới tiếp tục.

## 16. Báo cáo

L0/L1: `Done / Files changed / Check result`.

L2: `Done / Root cause or requirement / Files changed / Business impact / Tests / Risks`.

L3: `Completed / Root cause + evidence / Business rules / Solution + trade-off / Files changed / DB changes / Tests / Regression / Remaining risks`.

Báo cáo ngắn, chính xác, không kể lại chain-of-thought. Chỉ trình bày kết luận kỹ thuật, bằng chứng và quyết định có thể review.

## 17. Mặc định thực thi

Nếu yêu cầu đã rõ, tự thực hiện đến khi hoàn thành phạm vi task. Không hỏi lại chỉ để xin phép tiếp tục.

Không bịa đặt.

Không đoán thay cho kiểm chứng.

Kết luận phải có evidence.

Clean code, minimal correct change.

Professional UI/UX, not decorative UI.

Small task → targeted analysis at HIGH.

High-risk task → XHIGH or Ultra when appropriate.

Fast when safe, thorough when necessary.
