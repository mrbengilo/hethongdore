import { storePeriodUnlockedSql } from "../app/api/_lib/store-period-lock";

// These expressions only accept internal identifiers, never request text.
export function scheduleStartSql(data: string) {
  return `julianday(json_extract(${data}, '$.date') || 'T' || json_extract(${data}, '$.start') || ':00+07:00')`;
}
export function scheduleEndSql(data: string) {
  return `(julianday(json_extract(${data}, '$.date') || 'T' || json_extract(${data}, '$.end') || ':00+07:00') + CASE WHEN json_extract(${data}, '$.end') < json_extract(${data}, '$.start') THEN 1 ELSE 0 END)`;
}
export const scheduleActorAllowedSql = (actor: string, store: string) => `EXISTS (
  SELECT 1 FROM users actor WHERE actor.id = ${actor} AND (
    (actor.role = 'MANAGER' AND (actor.is_super_admin = 1 OR actor.store_id IS NULL OR actor.store_id = ${store}))
    OR (actor.role = 'HTKD' AND EXISTS (SELECT 1 FROM schedule_store_grants grant_scope
      WHERE grant_scope.user_id = actor.id AND grant_scope.store_id = ${store}))
  )
)`;

const slotPeriodGuard = (data: string, store: string) => `(${storePeriodUnlockedSql(store, `substr(json_extract(${data}, '$.date'),1,7)`)})
  AND (${storePeriodUnlockedSql(store, `strftime('%Y-%m', ${scheduleEndSql(data)} - 1.0/86400, '+7 hours')`)})`;

const incomingEmployeeSchedule = "CASE WHEN e.id=NEW.a_employee THEN NEW.b_after ELSE NEW.a_after END";
// Match the existing attendance route's transfer shift labels. Numbered Ca
// names take precedence; custom names use the planned starting hour.
const transferShiftLabel = `CASE
  WHEN instr(' ' || json_extract((${incomingEmployeeSchedule}),'$.shiftName') || ' ',' 1 ')>0 THEN 'Ca sáng'
  WHEN instr(' ' || json_extract((${incomingEmployeeSchedule}),'$.shiftName') || ' ',' 2 ')>0 THEN 'Ca chiều'
  WHEN instr(' ' || json_extract((${incomingEmployeeSchedule}),'$.shiftName') || ' ',' 3 ')>0 THEN 'Ca tối'
  WHEN json_extract((${incomingEmployeeSchedule}),'$.start')<'12:00' THEN 'Ca sáng'
  WHEN json_extract((${incomingEmployeeSchedule}),'$.start')<'18:00' THEN 'Ca chiều' ELSE 'Ca tối' END`;

const changedScheduleSql = `OLD.category = 'LICH_PHAN_CA' AND (
  NEW.category != OLD.category OR NEW.store_id IS NOT OLD.store_id OR NEW.status IS NOT OLD.status
  OR json_extract(NEW.data_json, '$.employeeIds') IS NOT json_extract(OLD.data_json, '$.employeeIds')
  OR json_extract(NEW.data_json, '$.date') IS NOT json_extract(OLD.data_json, '$.date')
  OR json_extract(NEW.data_json, '$.start') IS NOT json_extract(OLD.data_json, '$.start')
  OR json_extract(NEW.data_json, '$.end') IS NOT json_extract(OLD.data_json, '$.end'))`;

const overlapGuard = `SELECT CASE WHEN EXISTS (
  SELECT 1 FROM business_records other
  WHERE other.category = 'LICH_PHAN_CA' AND other.status NOT IN ('DELETED','VOID') AND other.id != NEW.id
    AND ${scheduleStartSql("other.data_json")} < ${scheduleEndSql("NEW.data_json")}
    AND ${scheduleEndSql("other.data_json")} > ${scheduleStartSql("NEW.data_json")}
    AND EXISTS (SELECT 1 FROM json_each(NEW.data_json, '$.employeeIds') incoming
      JOIN json_each(other.data_json, '$.employeeIds') current ON current.value = incoming.value)
) THEN RAISE(ABORT, 'SCHEDULE_OVERLAP') END;`;

const controlledSwapUpdate = `EXISTS (SELECT 1 FROM shift_swap_operations op WHERE op.status = 'APPLYING'
  AND ((op.a_id = NEW.id AND op.a_after = NEW.data_json) OR (op.b_id = NEW.id AND op.b_after = NEW.data_json)))`;

/**
 * A single INSERT is the transaction boundary on both native SQLite and D1.
 * All reads below run after SQLite acquired its write lock. Audit and replay
 * result cannot commit separately from either UPDATE, including RAISE(IGNORE).
 */
export const shiftSwapStatements = [
  `CREATE TABLE IF NOT EXISTS schedule_store_grants (
    user_id TEXT NOT NULL REFERENCES users(id), store_id TEXT NOT NULL REFERENCES stores(id),
    PRIMARY KEY (user_id, store_id))`,
  `CREATE TABLE IF NOT EXISTS shift_swap_operations (
    id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), store_id TEXT NOT NULL REFERENCES stores(id),
    work_date TEXT NOT NULL, request_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
    a_id TEXT NOT NULL, b_id TEXT NOT NULL, a_slot INTEGER NOT NULL, b_slot INTEGER NOT NULL,
    a_employee TEXT NOT NULL, b_employee TEXT NOT NULL,
    a_before TEXT NOT NULL CHECK(json_valid(a_before)), b_before TEXT NOT NULL CHECK(json_valid(b_before)),
    a_after TEXT NOT NULL CHECK(json_valid(a_after)), b_after TEXT NOT NULL CHECK(json_valid(b_after)),
    a_updated TEXT NOT NULL, b_updated TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)),
    reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 500), created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'APPLYING' CHECK(status IN ('APPLYING','COMPLETED')),
    UNIQUE(actor_id, request_key), CHECK(a_id != b_id), CHECK(a_employee != b_employee))`,
  `CREATE TRIGGER IF NOT EXISTS shift_swap_validate BEFORE INSERT ON shift_swap_operations BEGIN
    SELECT CASE WHEN NOT ${scheduleActorAllowedSql("NEW.actor_id", "NEW.store_id")} THEN RAISE(ABORT, 'SWAP_FORBIDDEN') END;
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM stores WHERE id=NEW.store_id AND status='ACTIVE') THEN RAISE(ABORT, 'SWAP_INACTIVE') END;
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM business_records WHERE id=NEW.a_id AND category='LICH_PHAN_CA'
      AND store_id=NEW.store_id AND status='ACTIVE' AND data_json=NEW.a_before AND updated_at=NEW.a_updated)
      OR NOT EXISTS(SELECT 1 FROM business_records WHERE id=NEW.b_id AND category='LICH_PHAN_CA'
      AND store_id=NEW.store_id AND status='ACTIVE' AND data_json=NEW.b_before AND updated_at=NEW.b_updated)
      THEN RAISE(ABORT, 'SWAP_STALE') END;
    SELECT CASE WHEN json_extract(NEW.a_before,'$.date') != NEW.work_date OR json_extract(NEW.b_before,'$.date') != NEW.work_date
      OR json_extract(NEW.a_before,'$.employeeIds[' || NEW.a_slot || ']') IS NOT NEW.a_employee
      OR json_extract(NEW.b_before,'$.employeeIds[' || NEW.b_slot || ']') IS NOT NEW.b_employee
      THEN RAISE(ABORT, 'SWAP_STALE') END;
    SELECT CASE WHEN ${scheduleStartSql("NEW.a_before")} IS NULL OR ${scheduleStartSql("NEW.b_before")} IS NULL
      OR ${scheduleStartSql("NEW.a_before")} <= julianday('now') OR ${scheduleStartSql("NEW.b_before")} <= julianday('now')
      THEN RAISE(ABORT, 'SWAP_STARTED') END;
    SELECT CASE WHEN NOT (${slotPeriodGuard("NEW.a_before", "NEW.store_id")}) OR NOT (${slotPeriodGuard("NEW.b_before", "NEW.store_id")})
      THEN RAISE(ABORT, 'SWAP_LOCKED') END;
    SELECT CASE WHEN EXISTS(SELECT 1 FROM shift_sessions session WHERE
      session.source_schedule_record_id IN (NEW.a_id,NEW.b_id)
      OR (session.employee_id IN (NEW.a_employee,NEW.b_employee) AND session.work_date=NEW.work_date
        AND ((session.scheduled_start=json_extract(NEW.a_before,'$.start') AND session.scheduled_end=json_extract(NEW.a_before,'$.end'))
          OR (session.scheduled_start=json_extract(NEW.b_before,'$.start') AND session.scheduled_end=json_extract(NEW.b_before,'$.end')))))
      THEN RAISE(ABORT, 'SWAP_ATTENDED') END;
    SELECT CASE WHEN (SELECT count(*) FROM employees e WHERE e.id IN (NEW.a_employee,NEW.b_employee) AND e.status='ACTIVE'
      AND EXISTS(SELECT 1 FROM stores home WHERE home.id=e.store_id AND home.status='ACTIVE')
      AND (e.store_id=NEW.store_id OR EXISTS(SELECT 1 FROM employee_transfers t WHERE t.employee_id=e.id
        AND t.target_store_id=NEW.store_id AND t.status IN ('SCHEDULED','ACTIVE') AND t.start_date<=NEW.work_date AND t.end_date>=NEW.work_date
        AND EXISTS(SELECT 1 FROM json_each(t.shifts_json) allowed WHERE allowed.value='Cả ngày' OR allowed.value=${transferShiftLabel})))) != 2
      THEN RAISE(ABORT, 'SWAP_EMPLOYEE') END;
    SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.a_after,'$.employeeIds') GROUP BY value HAVING count(*)>1)
      OR EXISTS (SELECT 1 FROM json_each(NEW.b_after,'$.employeeIds') GROUP BY value HAVING count(*)>1)
      THEN RAISE(ABORT, 'SWAP_OVERLAP') END;
    SELECT CASE WHEN (${scheduleStartSql("NEW.a_after")} < ${scheduleEndSql("NEW.b_after")} AND ${scheduleEndSql("NEW.a_after")} > ${scheduleStartSql("NEW.b_after")}
      AND EXISTS(SELECT 1 FROM json_each(NEW.a_after,'$.employeeIds') a JOIN json_each(NEW.b_after,'$.employeeIds') b ON a.value=b.value))
      OR EXISTS(SELECT 1 FROM business_records other WHERE other.category='LICH_PHAN_CA' AND other.status NOT IN ('DELETED','VOID')
        AND other.id NOT IN (NEW.a_id,NEW.b_id) AND (
          (${scheduleStartSql("other.data_json")} < ${scheduleEndSql("NEW.a_after")} AND ${scheduleEndSql("other.data_json")} > ${scheduleStartSql("NEW.a_after")}
            AND EXISTS(SELECT 1 FROM json_each(other.data_json,'$.employeeIds') e WHERE e.value=NEW.b_employee))
          OR (${scheduleStartSql("other.data_json")} < ${scheduleEndSql("NEW.b_after")} AND ${scheduleEndSql("other.data_json")} > ${scheduleStartSql("NEW.b_after")}
            AND EXISTS(SELECT 1 FROM json_each(other.data_json,'$.employeeIds') e WHERE e.value=NEW.a_employee))))
      THEN RAISE(ABORT, 'SWAP_OVERLAP') END;
  END`,
  `CREATE TRIGGER IF NOT EXISTS shift_swap_apply AFTER INSERT ON shift_swap_operations BEGIN
    UPDATE business_records SET data_json=NEW.a_after, updated_at=NEW.created_at WHERE id=NEW.a_id AND data_json=NEW.a_before AND updated_at=NEW.a_updated;
    SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'SWAP_INCOMPLETE') END;
    UPDATE business_records SET data_json=NEW.b_after, updated_at=NEW.created_at WHERE id=NEW.b_id AND data_json=NEW.b_before AND updated_at=NEW.b_updated;
    SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'SWAP_INCOMPLETE') END;
    INSERT INTO audit_logs(id,user_id,store_id,action,entity_type,entity_id,detail,before_json,after_json,reason,created_at)
      VALUES ('swap-audit:'||NEW.id, NEW.actor_id, NEW.store_id, 'SWAP_SCHEDULE', 'LICH_PHAN_CA', NEW.id,
        'Swap two schedule assignment slots', json_object('a',json(NEW.a_before),'b',json(NEW.b_before)),
        json_object('a',json(NEW.a_after),'b',json(NEW.b_after),'aRecordId',NEW.a_id,'bRecordId',NEW.b_id,
          'aSlot',NEW.a_slot,'bSlot',NEW.b_slot,'date',NEW.work_date), NEW.reason,NEW.created_at);
    SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'SWAP_INCOMPLETE') END;
    UPDATE shift_swap_operations SET status='COMPLETED' WHERE id=NEW.id;
    SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'SWAP_INCOMPLETE') END;
  END`,
  `CREATE TRIGGER IF NOT EXISTS schedule_write_overlap_insert BEFORE INSERT ON business_records
    WHEN NEW.category='LICH_PHAN_CA' AND NEW.status NOT IN ('DELETED','VOID') BEGIN ${overlapGuard} END`,
  `CREATE TRIGGER IF NOT EXISTS schedule_write_overlap_update BEFORE UPDATE ON business_records
    WHEN (${changedScheduleSql}) AND NEW.category='LICH_PHAN_CA' AND NEW.status NOT IN ('DELETED','VOID')
      AND NOT (${controlledSwapUpdate}) BEGIN ${overlapGuard} END`,
  `CREATE TRIGGER IF NOT EXISTS schedule_write_history_guard BEFORE UPDATE ON business_records
    WHEN (${changedScheduleSql}) AND OLD.status NOT IN ('DELETED','VOID') BEGIN
      SELECT CASE WHEN ${scheduleStartSql("OLD.data_json")} <= julianday('now')
        OR EXISTS(SELECT 1 FROM shift_sessions WHERE source_schedule_record_id=OLD.id)
        THEN RAISE(ABORT,'SCHEDULE_STARTED') END;
      SELECT CASE WHEN NOT (${slotPeriodGuard("OLD.data_json", "OLD.store_id")}) THEN RAISE(ABORT,'SCHEDULE_LOCKED') END;
    END`,
  `CREATE TRIGGER IF NOT EXISTS shift_swap_completed_immutable BEFORE UPDATE ON shift_swap_operations
    WHEN OLD.status='COMPLETED' BEGIN SELECT RAISE(ABORT,'SWAP_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS shift_swap_operation_no_delete BEFORE DELETE ON shift_swap_operations
    BEGIN SELECT RAISE(ABORT,'SWAP_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS shift_swap_audit_no_update BEFORE UPDATE ON audit_logs
    WHEN OLD.action='SWAP_SCHEDULE' BEGIN SELECT RAISE(ABORT,'SWAP_AUDIT_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS shift_swap_audit_no_delete BEFORE DELETE ON audit_logs
    WHEN OLD.action='SWAP_SCHEDULE' BEGIN SELECT RAISE(ABORT,'SWAP_AUDIT_IMMUTABLE'); END`,
];
