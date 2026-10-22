CREATE TABLE IF NOT EXISTS business_records (id TEXT PRIMARY KEY, category TEXT NOT NULL, store_id TEXT, owner_id TEXT, title TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS shift_sessions (id TEXT PRIMARY KEY, shift_code TEXT NOT NULL UNIQUE, shift_name TEXT, store_id TEXT NOT NULL, employee_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, scheduled_start_at TEXT, scheduled_end_at TEXT, rollover_from TEXT, work_session_id TEXT, auto_rolled INTEGER NOT NULL DEFAULT 0, tiktok INTEGER NOT NULL DEFAULT 0, tiktok_allowance INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ACTIVE');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS user_store_scopes (user_id TEXT NOT NULL REFERENCES users(id), store_id TEXT NOT NULL REFERENCES stores(id), PRIMARY KEY(user_id,store_id));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS shift_definitions (id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id), name TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, CHECK(start_time != end_time));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS shift_assignments (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id), employee_id TEXT NOT NULL REFERENCES employees(id), business_date TEXT NOT NULL,
 definition_id TEXT NOT NULL REFERENCES shift_definitions(id), shift_name TEXT NOT NULL, scheduled_start_at TEXT NOT NULL, scheduled_end_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'PLANNED' CHECK(status IN ('PLANNED','CANCELLED')), version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_by TEXT NOT NULL REFERENCES users(id), updated_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK(scheduled_end_at>scheduled_start_at));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_assignment_overlap ON shift_assignments(employee_id,status,scheduled_start_at,scheduled_end_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_assignment_day ON shift_assignments(store_id,business_date,status);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_assignment_unique ON shift_assignments(employee_id,business_date,definition_id) WHERE status='PLANNED';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS shift_assignment_sessions (assignment_id TEXT PRIMARY KEY REFERENCES shift_assignments(id), session_id TEXT NOT NULL UNIQUE REFERENCES shift_sessions(id));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS shift_swaps (
 id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), store_id TEXT NOT NULL REFERENCES stores(id), business_date TEXT NOT NULL,
 assignment_a_id TEXT NOT NULL REFERENCES shift_assignments(id), assignment_b_id TEXT NOT NULL REFERENCES shift_assignments(id), version_a INTEGER NOT NULL, version_b INTEGER NOT NULL,
 idempotency_key TEXT NOT NULL, payload TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, result_json TEXT NOT NULL DEFAULT '[]',
 state TEXT NOT NULL DEFAULT 'APPLYING' CHECK(state IN ('APPLYING','DONE')), UNIQUE(actor_id,idempotency_key));
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS schedule_definition_insert BEFORE INSERT ON shift_definitions BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users u JOIN stores s ON s.id=NEW.store_id AND s.status='ACTIVE' WHERE u.id=NEW.created_by AND (u.role='MANAGER' OR (u.role IN ('HTKD','STORE_MANAGER') AND EXISTS(SELECT 1 FROM user_store_scopes p WHERE p.user_id=u.id AND p.store_id=s.id)))) THEN RAISE(ABORT,'SCHEDULE_FORBIDDEN') END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS schedule_assignment_insert BEFORE INSERT ON shift_assignments BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users u JOIN stores s ON s.id=NEW.store_id AND s.status='ACTIVE' WHERE u.id=NEW.updated_by AND (u.role='MANAGER' OR (u.role IN ('HTKD','STORE_MANAGER') AND EXISTS(SELECT 1 FROM user_store_scopes p WHERE p.user_id=u.id AND p.store_id=s.id)))) THEN RAISE(ABORT,'SCHEDULE_FORBIDDEN') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM employees WHERE id=NEW.employee_id AND store_id=NEW.store_id AND status='ACTIVE') OR NOT EXISTS(SELECT 1 FROM shift_definitions WHERE id=NEW.definition_id AND store_id=NEW.store_id) THEN RAISE(ABORT,'SCHEDULE_ELIGIBILITY') END;
 SELECT CASE WHEN julianday(NEW.scheduled_start_at)<=julianday('now') THEN RAISE(ABORT,'SCHEDULE_STARTED') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM business_records WHERE category='PAYROLL_PERIOD' AND store_id=NEW.store_id AND status='LOCKED' AND json_extract(data_json,'$.month') BETWEEN substr(NEW.business_date,1,7) AND strftime('%Y-%m',julianday(NEW.scheduled_end_at)-0.00000001,'+7 hours')) THEN RAISE(ABORT,'SCHEDULE_LOCKED') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM shift_assignments WHERE employee_id=NEW.employee_id AND status='PLANNED' AND scheduled_start_at<NEW.scheduled_end_at AND scheduled_end_at>NEW.scheduled_start_at) THEN RAISE(ABORT,'SCHEDULE_OVERLAP') END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS schedule_assignment_update BEFORE UPDATE ON shift_assignments BEGIN
 SELECT CASE WHEN NEW.id!=OLD.id OR NEW.store_id!=OLD.store_id OR NEW.business_date!=OLD.business_date OR NEW.definition_id!=OLD.definition_id OR NEW.scheduled_start_at!=OLD.scheduled_start_at OR NEW.scheduled_end_at!=OLD.scheduled_end_at OR NEW.shift_name!=OLD.shift_name OR NEW.created_by!=OLD.created_by OR NEW.created_at!=OLD.created_at OR NEW.version!=OLD.version+1 OR OLD.status!='PLANNED' THEN RAISE(ABORT,'SCHEDULE_CONFLICT') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users u JOIN stores s ON s.id=NEW.store_id AND s.status='ACTIVE' WHERE u.id=NEW.updated_by AND (u.role='MANAGER' OR (u.role IN ('HTKD','STORE_MANAGER') AND EXISTS(SELECT 1 FROM user_store_scopes p WHERE p.user_id=u.id AND p.store_id=s.id)))) THEN RAISE(ABORT,'SCHEDULE_FORBIDDEN') END;
 SELECT CASE WHEN julianday(OLD.scheduled_start_at)<=julianday('now') OR EXISTS(SELECT 1 FROM shift_assignment_sessions WHERE assignment_id=OLD.id) OR EXISTS(SELECT 1 FROM shift_sessions ss WHERE ss.employee_id=OLD.employee_id AND (ss.ended_at IS NULL OR (ss.started_at<OLD.scheduled_end_at AND ss.ended_at>OLD.scheduled_start_at))) THEN RAISE(ABORT,'SCHEDULE_STARTED') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM business_records WHERE category='PAYROLL_PERIOD' AND store_id=OLD.store_id AND status='LOCKED' AND json_extract(data_json,'$.month') BETWEEN substr(OLD.business_date,1,7) AND strftime('%Y-%m',julianday(OLD.scheduled_end_at)-0.00000001,'+7 hours')) THEN RAISE(ABORT,'SCHEDULE_LOCKED') END;
 SELECT CASE WHEN NEW.status='PLANNED' AND NOT EXISTS(SELECT 1 FROM employees WHERE id=NEW.employee_id AND store_id=NEW.store_id AND status='ACTIVE') THEN RAISE(ABORT,'SCHEDULE_ELIGIBILITY') END;
 -- Only the validated swap statement may change an employee at a fixed slot.
 SELECT CASE WHEN NEW.employee_id!=OLD.employee_id AND NOT EXISTS(SELECT 1 FROM shift_swaps WHERE state='APPLYING' AND (assignment_a_id=OLD.id OR assignment_b_id=OLD.id)) THEN RAISE(ABORT,'SCHEDULE_CONFLICT') END;
 SELECT CASE WHEN NEW.status='PLANNED' AND EXISTS(SELECT 1 FROM shift_assignments x WHERE x.id!=NEW.id AND x.employee_id=NEW.employee_id AND x.status='PLANNED' AND x.scheduled_start_at<NEW.scheduled_end_at AND x.scheduled_end_at>NEW.scheduled_start_at AND NOT EXISTS(SELECT 1 FROM shift_swaps op WHERE op.state='APPLYING' AND (op.assignment_a_id=NEW.id OR op.assignment_b_id=NEW.id) AND (op.assignment_a_id=x.id OR op.assignment_b_id=x.id))) THEN RAISE(ABORT,'SCHEDULE_OVERLAP') END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS schedule_assignment_delete BEFORE DELETE ON shift_assignments BEGIN SELECT RAISE(ABORT,'SCHEDULE_CONFLICT'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS schedule_create_audit AFTER INSERT ON shift_assignments BEGIN
 INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,detail,created_at) VALUES(lower(hex(randomblob(16))),NEW.created_by,'SCHEDULE_CREATE','SHIFT_ASSIGNMENT',NEW.id,json_object('after',json_object('employeeId',NEW.employee_id,'start',NEW.scheduled_start_at,'end',NEW.scheduled_end_at),'reason','Phân công lịch dự kiến'),NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS schedule_cancel_audit AFTER UPDATE ON shift_assignments WHEN NEW.status='CANCELLED' BEGIN
 INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,detail,created_at) VALUES(lower(hex(randomblob(16))),NEW.updated_by,'SCHEDULE_CANCEL','SHIFT_ASSIGNMENT',NEW.id,json_object('before',OLD.status,'after',NEW.status,'reason','Hủy phân công dự kiến'),NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS schedule_swap_validate BEFORE INSERT ON shift_swaps BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users u JOIN stores s ON s.id=NEW.store_id AND s.status='ACTIVE' WHERE u.id=NEW.actor_id AND (u.role='MANAGER' OR (u.role IN ('HTKD','STORE_MANAGER') AND EXISTS(SELECT 1 FROM user_store_scopes p WHERE p.user_id=u.id AND p.store_id=s.id)))) THEN RAISE(ABORT,'SCHEDULE_FORBIDDEN') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM shift_assignments a JOIN shift_assignments b ON b.id=NEW.assignment_b_id WHERE a.id=NEW.assignment_a_id AND a.id!=b.id AND a.employee_id!=b.employee_id AND a.store_id=NEW.store_id AND b.store_id=NEW.store_id AND a.business_date=NEW.business_date AND b.business_date=NEW.business_date AND a.status='PLANNED' AND b.status='PLANNED' AND a.version=NEW.version_a AND b.version=NEW.version_b) THEN RAISE(ABORT,'SCHEDULE_CONFLICT') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM shift_assignments a JOIN shift_assignments b ON b.id=NEW.assignment_b_id WHERE a.id=NEW.assignment_a_id AND a.scheduled_start_at=b.scheduled_start_at AND a.scheduled_end_at=b.scheduled_end_at) THEN RAISE(ABORT,'SCHEDULE_NOOP') END;
 -- Validate the final schedule of BOTH people against all dates/stores, excluding
 -- exactly the two old assignments. Half-open intervals permit adjacent shifts.
 SELECT CASE WHEN EXISTS(SELECT 1 FROM shift_assignments a JOIN shift_assignments b ON b.id=NEW.assignment_b_id JOIN shift_assignments x ON x.id NOT IN (a.id,b.id) AND x.status='PLANNED' WHERE a.id=NEW.assignment_a_id AND ((x.employee_id=b.employee_id AND x.scheduled_start_at<a.scheduled_end_at AND x.scheduled_end_at>a.scheduled_start_at) OR (x.employee_id=a.employee_id AND x.scheduled_start_at<b.scheduled_end_at AND x.scheduled_end_at>b.scheduled_start_at))) THEN RAISE(ABORT,'SCHEDULE_OVERLAP') END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS schedule_swap_apply AFTER INSERT ON shift_swaps BEGIN
 INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,detail,created_at)
 SELECT NEW.id,NEW.actor_id,'SHIFT_SWAP','SHIFT_SWAP',NEW.id,json_object('actor',json_object('id',u.id,'name',u.name,'role',u.role),'operationId',NEW.id,'storeId',NEW.store_id,'date',NEW.business_date,'reason',NEW.reason,'before',json_array(json_object('id',a.id,'employeeId',a.employee_id,'version',a.version,'start',a.scheduled_start_at,'end',a.scheduled_end_at),json_object('id',b.id,'employeeId',b.employee_id,'version',b.version,'start',b.scheduled_start_at,'end',b.scheduled_end_at)),'after',json_array(json_object('id',a.id,'employeeId',b.employee_id,'version',a.version+1,'start',a.scheduled_start_at,'end',a.scheduled_end_at),json_object('id',b.id,'employeeId',a.employee_id,'version',b.version+1,'start',b.scheduled_start_at,'end',b.scheduled_end_at))),NEW.created_at
 FROM shift_assignments a JOIN shift_assignments b ON b.id=NEW.assignment_b_id JOIN users u ON u.id=NEW.actor_id WHERE a.id=NEW.assignment_a_id;
 UPDATE shift_assignments SET employee_id=json_extract((SELECT detail FROM audit_logs WHERE id=NEW.id),'$.after[0].employeeId'),version=version+1,updated_by=NEW.actor_id,updated_at=NEW.created_at WHERE id=NEW.assignment_a_id AND version=NEW.version_a;
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'SCHEDULE_CONFLICT') END;
 UPDATE shift_assignments SET employee_id=json_extract((SELECT detail FROM audit_logs WHERE id=NEW.id),'$.after[1].employeeId'),version=version+1,updated_by=NEW.actor_id,updated_at=NEW.created_at WHERE id=NEW.assignment_b_id AND version=NEW.version_b;
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'SCHEDULE_CONFLICT') END;
 UPDATE shift_swaps SET state='DONE',result_json=(SELECT json_group_array(json_object('id',id,'store_id',store_id,'employee_id',employee_id,'business_date',business_date,'definition_id',definition_id,'shift_name',shift_name,'scheduled_start_at',scheduled_start_at,'scheduled_end_at',scheduled_end_at,'status',status,'version',version)) FROM shift_assignments WHERE id IN (NEW.assignment_a_id,NEW.assignment_b_id)) WHERE id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS schedule_swap_immutable BEFORE UPDATE ON shift_swaps WHEN OLD.state='DONE' BEGIN SELECT RAISE(ABORT,'SCHEDULE_CONFLICT'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS schedule_swap_no_delete BEFORE DELETE ON shift_swaps BEGIN SELECT RAISE(ABORT,'SCHEDULE_CONFLICT'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS schedule_audit_immutable BEFORE UPDATE ON audit_logs WHEN OLD.action LIKE 'SCHEDULE_%' OR OLD.action='SHIFT_SWAP' BEGIN SELECT RAISE(ABORT,'SCHEDULE_CONFLICT'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS schedule_audit_no_delete BEFORE DELETE ON audit_logs WHEN OLD.action LIKE 'SCHEDULE_%' OR OLD.action='SHIFT_SWAP' BEGIN SELECT RAISE(ABORT,'SCHEDULE_CONFLICT'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS schedule_attendance_insert BEFORE INSERT ON shift_sessions BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM business_records WHERE category='PAYROLL_PERIOD' AND store_id=NEW.store_id AND status='LOCKED' AND json_extract(data_json,'$.month')=strftime('%Y-%m',NEW.started_at,'+7 hours')) THEN RAISE(ABORT,'SCHEDULE_LOCKED') END;
 SELECT CASE WHEN NEW.ended_at IS NULL AND EXISTS(SELECT 1 FROM shift_sessions WHERE employee_id=NEW.employee_id AND ended_at IS NULL) THEN RAISE(ABORT,'SCHEDULE_STARTED') END;
 -- A legacy start read before a concurrent assignment creation cannot bypass it.
 SELECT CASE WHEN NEW.shift_code NOT LIKE 'ASG-%' AND NEW.rollover_from IS NULL AND EXISTS(SELECT 1 FROM shift_assignments WHERE employee_id=NEW.employee_id AND status='PLANNED' AND (business_date=strftime('%Y-%m-%d',NEW.started_at,'+7 hours') OR (scheduled_start_at<=NEW.started_at AND scheduled_end_at>NEW.started_at))) THEN RAISE(ABORT,'SCHEDULE_CONFLICT') END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS schedule_attendance_link BEFORE INSERT ON shift_assignment_sessions BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM shift_assignments a JOIN shift_sessions s ON s.id=NEW.session_id WHERE a.id=NEW.assignment_id AND a.status='PLANNED' AND a.employee_id=s.employee_id AND a.store_id=s.store_id AND a.scheduled_start_at=s.scheduled_start_at AND a.scheduled_end_at=s.scheduled_end_at AND a.scheduled_start_at<=s.started_at AND a.scheduled_end_at>s.started_at AND EXISTS(SELECT 1 FROM employees e WHERE e.id=a.employee_id AND e.store_id=a.store_id AND e.status='ACTIVE')) THEN RAISE(ABORT,'SCHEDULE_CONFLICT') END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS schedule_attendance_link_period BEFORE INSERT ON shift_assignment_sessions BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM shift_assignments a JOIN business_records p ON p.store_id=a.store_id AND p.category='PAYROLL_PERIOD' AND p.status='LOCKED' WHERE a.id=NEW.assignment_id AND json_extract(p.data_json,'$.month') BETWEEN substr(a.business_date,1,7) AND strftime('%Y-%m',julianday(a.scheduled_end_at)-0.00000001,'+7 hours')) THEN RAISE(ABORT,'SCHEDULE_LOCKED') END;
END;
--> statement-breakpoint
-- A stale write through the generic records API must not erase the safety gate.
CREATE TRIGGER IF NOT EXISTS schedule_locked_period_update BEFORE UPDATE ON business_records WHEN OLD.category='PAYROLL_PERIOD' AND OLD.status='LOCKED' BEGIN SELECT RAISE(ABORT,'SCHEDULE_LOCKED'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS schedule_locked_period_delete BEFORE DELETE ON business_records WHEN OLD.category='PAYROLL_PERIOD' AND OLD.status='LOCKED' BEGIN SELECT RAISE(ABORT,'SCHEDULE_LOCKED'); END;
