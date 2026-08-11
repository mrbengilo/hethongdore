"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3, CheckCircle2, ChevronLeft, ChevronRight, Clock3,
  Download, Edit3, ExternalLink, Gift, MapPin, PackageOpen, Plus, Search, Trash2, UserRound,
  UsersRound, WalletCards, X,
} from "lucide-react";
import StorePayrollClosing from "./StorePayrollClosing";
import SalaryAdvancePanel from "./SalaryAdvancePanel";
import { formatDateTime24, formatDateVn, formatMonthVn, formatVndInput, parseVndInput } from "../lib/format";
import { PAYROLL_UPDATED_EVENT } from "../lib/payroll";
import {
  ATTENDANCE_ON_TIME_GRACE_MINUTES,
  attendanceDeltaMinutes,
  attendanceStatusAt,
} from "../lib/scheduling";
import { DatePickerControl } from "./DatePickerControl";
import { useAccessibleModal } from "./useAccessibleModal";

export type ReferenceStore = {
  id: string; name: string; address: string; revenue: number; expense: number;
  profit: number; status: string;
};
type BusinessRecord = {
  id: string; title: string; data: Record<string, unknown>; status: string;
  created_at?: string; updated_at: string;
};
type Employee = {
  id: string; store_id: string; code: string; name: string; position: string;
  phone: string; hourly_rate: number; status: string; username?: string;
};
type ShiftSession = {
  id: string; shift_code: string; started_at: string; ended_at: string | null;
  employeeCode: string; employeeName: string; hourlyRate: number; status: string;
  shiftName?: string | null; workDate?: string | null; appliedHourlyRate?: number | null; transfer_id?: string | null;
  tiktok_allowance?: number; cash_revenue?: number; transfer_revenue?: number;
  expense_amount?: number; expense_note?: string;
  duration_seconds?: number; admin_adjusted_duration_seconds?: number | null; adminAdjustedDurationSeconds?: number | null; supportAllowance?: number | null; sourceStoreName?: string | null; targetStoreName?: string | null;
  scheduled_start_at?: string | null; attendance_status?: "EARLY" | "ON_TIME" | "LATE" | null;
  attendance_delta_minutes?: number | null;
  clockInLatitude?: number | null; clockInLongitude?: number | null;
  clockInAccuracyMeters?: number | null; clockInLocationCapturedAt?: string | null;
  clock_in_latitude?: number | null; clock_in_longitude?: number | null;
  clock_in_accuracy_meters?: number | null; clock_in_location_captured_at?: string | null;
};
type AttendanceLocation = {
  latitude: number; longitude: number; accuracyMeters: number | null; capturedAt: string | null;
};
type PayrollItem = {
  employeeId: string; employeeCode: string; employeeName: string; position: string;
  hours: number; hourlyRate: number; baseSalary: number; tiktokAllowance: number;
  supportAllowance: number; manualAllowance: number; manualBonus: number; kpiBonus: number; totalPay: number;
  salaryAdvancePending: number; salaryAdvancePaid: number; salaryAdvanceReserved: number; availablePay: number;
};
type PayrollSummary = {
  period: string; storeId: string; storeName: string; revenue: number; expense: number;
  profit: number; netProfit?: number; totalHours: number; kpiEligibleHours?: number;
  managerFixedHours?: number; totalKpiHours?: number; profitPerHour: number; profitPerKpiHour?: number; kpiRate: number;
  totalBaseSalary: number; totalTikTokAllowance: number; totalSupportAllowance: number; totalManualAllowance: number;
  totalManualBonus: number; totalKpiBonus: number; totalPay: number;
  totalSalaryAdvancePending: number; totalSalaryAdvancePaid: number; totalSalaryAdvanceReserved: number; totalAvailablePay: number;
  items: PayrollItem[]; status: "PREVIEW" | "LOCKED"; finalizedAt?: string;
};
type PayrollScope = { storeId: string; period: string };
type PayrollResponse = { period?: string; locked?: boolean; summary?: PayrollSummary; message?: string };

const samePayrollScope = (left: PayrollScope, right: PayrollScope) => left.storeId === right.storeId && left.period === right.period;

const money = (value: number) => new Intl.NumberFormat("en-US").format(Math.round(value)) + " Ä‘á»“ng";
const hourlyMoney = (value: number) => `${money(value)}/giá»`;
const employeeStatusSuffix = (status: string) => status === "SUSPENDED"
  ? " Â· Táº¡m ngÆ°ng"
  : status === "TERMINATED" || status === "INACTIVE" ? " Â· ÄÃ£ nghá»‰ viá»‡c" : "";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
const dateLabel = (value: string) => formatDateVn(value);
const timeLabel = (value: string | null) => value ? new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh", hourCycle: "h23" }).format(new Date(value)) : "â€”";
const locationTimeLabel = (value: string | null) => value && Number.isFinite(new Date(value).getTime())
  ? formatDateTime24(value)
  : "ChÆ°a cÃ³ thá»i Ä‘iá»ƒm láº¥y";
const finiteField = (primary: unknown, fallback: unknown) => {
  const value = primary ?? fallback;
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};
const sessionLocation = (shift: ShiftSession): AttendanceLocation | null => {
  const latitude = finiteField(shift.clockInLatitude, shift.clock_in_latitude);
  const longitude = finiteField(shift.clockInLongitude, shift.clock_in_longitude);
  if (latitude === null || longitude === null || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  const rawAccuracy = finiteField(shift.clockInAccuracyMeters, shift.clock_in_accuracy_meters);
  return {
    latitude,
    longitude,
    accuracyMeters: rawAccuracy !== null && rawAccuracy >= 0 ? rawAccuracy : null,
    capturedAt: shift.clockInLocationCapturedAt ?? shift.clock_in_location_captured_at ?? null,
  };
};
const locationMapUrl = (location: AttendanceLocation) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${location.latitude},${location.longitude}`)}`;
const locationExportLabel = (locations: AttendanceLocation[]) => locations.length === 0
  ? "KhÃ´ng cÃ³ dá»¯ liá»‡u vá»‹ trÃ­"
  : locations.map((location) => `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)} Â· ${location.accuracyMeters === null ? "chÆ°a cÃ³ Ä‘á»™ chÃ­nh xÃ¡c" : `Â±${Math.round(location.accuracyMeters)} m`} Â· ${locationTimeLabel(location.capturedAt)}`).join("; ");
const sessionRate = (shift: { hourlyRate: number; appliedHourlyRate?: number | null }) => Number(shift.appliedHourlyRate ?? shift.hourlyRate ?? 0);
const sessionSeconds = (shift: ShiftSession) => {
  const adjusted = shift.adminAdjustedDurationSeconds ?? shift.admin_adjusted_duration_seconds;
  if (adjusted != null) return Math.max(0, Number(adjusted));
  if (Number(shift.duration_seconds) > 0) return Number(shift.duration_seconds);
  const start = new Date(shift.started_at).getTime();
  const end = shift.ended_at ? new Date(shift.ended_at).getTime() : Date.now();
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 1_000)) : 0;
};
const sessionDate = (shift: ShiftSession) => shift.workDate
  ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(shift.started_at));
const sessionAttendance = (shift: ShiftSession) => {
  const persistedStatus = shift.attendance_status;
  const persistedDelta = Number(shift.attendance_delta_minutes);
  if (persistedStatus && shift.attendance_delta_minutes !== null && shift.attendance_delta_minutes !== undefined
    && Number.isFinite(persistedDelta)) return { status: persistedStatus, delta: persistedDelta };
  if (!shift.scheduled_start_at) return null;
  const delta = attendanceDeltaMinutes(shift.started_at, shift.scheduled_start_at);
  const status = attendanceStatusAt(shift.started_at, shift.scheduled_start_at);
  return delta === null || status === null ? null : { status, delta };
};
type ShiftDisplay = { id: string; title: string; start: string; end: string; tone: string; record?: BusinessRecord };
const defaultShifts: ShiftDisplay[] = [
  { id: "default-1", title: "Ca 1", start: "07:00", end: "12:00", tone: "s1" },
  { id: "default-2", title: "Ca 2", start: "12:00", end: "17:00", tone: "s2" },
  { id: "default-3", title: "Ca 3", start: "17:00", end: "23:00", tone: "s3" },
];
const samplePeople = [
  ["Nguyá»…n Thá»‹ An", "BÃ¡n hÃ ng"], ["Tráº§n VÄƒn BÃ¬nh", "BÃ¡n hÃ ng"],
  ["LÃª Thá»‹ CÃºc", "Thu ngÃ¢n"], ["Pháº¡m HoÃ ng DÅ©ng", "Kho"],
  ["VÃµ Thá»‹ Mai", "BÃ¡n hÃ ng"], ["Äáº·ng Minh Khang", "BÃ¡n hÃ ng"],
];
const sampleGoods = [
  ["ChÃ¢n vÃ¡y", 15, "Bao", 120, 120000, 15000],
  ["Äá»“ nam", 20, "Bao", 210.5, 150000, 20000],
  ["Ão dÃ i", 10, "Bao", 80, 200000, 15000],
  ["Äá»“ bá»™", 18, "Bao", 150.3, 130000, 18000],
  ["Phá»¥ kiá»‡n", 25, "Bao", 45, 60000, 10000],
] as const;

function csv(filename: string, rows: Array<Array<string | number | null | undefined>>) {
  const safe = (value: string | number | null | undefined) => {
    const raw = String(value ?? ""); const protectedValue = /^[=+\-@]/.test(raw) ? "'" + raw : raw;
    return '"' + protectedValue.replaceAll('"', '""') + '"';
  };
  const blob = new Blob(["\uFEFF" + rows.map((row) => row.map(safe).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
}

function useRecords(category: string, storeId: string) {
  const [records, setRecords] = useState<BusinessRecord[]>([]);
  const reload = useCallback(async () => {
    const q = new URLSearchParams({ category, storeId });
    const data = await (await fetch("/api/records?" + q)).json();
    setRecords(data.records ?? []);
  }, [category, storeId]);
  useEffect(() => { reload(); }, [reload]);
  return { records, reload };
}

function useEmployees(storeId: string, payrollPeriod?: string) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const reload = useCallback(async () => {
    const query = new URLSearchParams({ storeId, includeSupport: "1" });
    if (payrollPeriod) query.set("payrollPeriod", payrollPeriod);
    const response = await fetch("/api/employees?" + query);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "KhÃ´ng thá»ƒ táº£i danh sÃ¡ch nhÃ¢n viÃªn.");
    setEmployees(data.employees ?? []);
  }, [payrollPeriod, storeId]);
  useEffect(() => { void reload(); }, [reload]);
  return { employees, reload };
}

function useShiftSessions(storeId: string) {
  const [shifts, setShifts] = useState<ShiftSession[]>([]);
  const reload = useCallback(async () => {
    const data = await (await fetch("/api/shifts?storeId=" + encodeURIComponent(storeId))).json();
    setShifts(data.shifts ?? []);
  }, [storeId]);
  useEffect(() => { reload(); }, [reload]);
  return { shifts, reload };
}

async function saveRecord(input: {
  id?: string; category: string; storeId: string; title: string; data: Record<string, unknown>;
}) {
  const response = await fetch("/api/records", {
    method: input.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "KhÃ´ng thá»ƒ lÆ°u dá»¯ liá»‡u");
}

async function deleteRecord(id: string, reportError: (message: string) => void = (message) => window.alert(message)) {
  if (!confirm("Báº¡n cÃ³ cháº¯c muá»‘n xÃ³a dá»¯ liá»‡u nÃ y?")) return false;
  try {
    const response = await fetch("/api/records?id=" + encodeURIComponent(id), { method: "DELETE" });
    const result = await response.json().catch(() => ({})) as { message?: string };
    if (!response.ok) {
      reportError(result.message || "KhÃ´ng thá»ƒ xÃ³a dá»¯ liá»‡u.");
      return false;
    }
    return true;
  } catch {
    reportError("KhÃ´ng thá»ƒ káº¿t ná»‘i Ä‘á»ƒ xÃ³a dá»¯ liá»‡u. Vui lÃ²ng thá»­ láº¡i.");
    return false;
  }
}

function Metric({ icon: Icon, label, value, note, tone = "green" }: {
  icon: typeof Clock3; label: string; value: string; note?: string; tone?: string;
}) {
  return <article className={"ref-metric " + tone}><i><Icon size={23}/></i><div><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div></article>;
}

function Person({ name, position }: { name: string; position: string }) {
  return <div className="ref-person"><i>{name.slice(0, 1)}</i><span><b>{name}</b><small>{position}</small></span></div>;
}

function AttendanceLocationView({ locations, employeeName }: { locations: AttendanceLocation[]; employeeName: string }) {
  if (locations.length === 0) return <span className="attendance-location-empty">KhÃ´ng cÃ³ dá»¯ liá»‡u vá»‹ trÃ­</span>;
  const items = locations.map((location, index) => <div className="attendance-location-item" key={`${location.capturedAt ?? "legacy"}-${location.latitude}-${location.longitude}-${index}`}>
    <a
      href={locationMapUrl(location)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Má»Ÿ vá»‹ trÃ­ Ä‘iá»ƒm danh cá»§a ${employeeName} trÃªn Google Maps`}
    >
      <MapPin size={14} aria-hidden="true"/> Má»Ÿ báº£n Ä‘á»“ <ExternalLink size={12} aria-hidden="true"/>
    </a>
    <span>{location.latitude.toFixed(6)}, {location.longitude.toFixed(6)}</span>
    <small>{location.accuracyMeters === null ? "ChÆ°a cÃ³ Ä‘á»™ chÃ­nh xÃ¡c" : `Äá»™ chÃ­nh xÃ¡c Â±${Math.round(location.accuracyMeters)} m`}</small>
    <time dateTime={location.capturedAt ?? undefined}>Láº¥y lÃºc {locationTimeLabel(location.capturedAt)}</time>
  </div>);
  if (items.length === 1) return items[0];
  return <details className="attendance-location-group">
    <summary>{locations.length} vá»‹ trÃ­ Ä‘iá»ƒm danh</summary>
    <div>{items}</div>
  </details>;
}

function MiniBars({ values = [13, 11, 15, 8, 17, 12, 18, 14, 10, 16, 13, 19, 15] }: { values?: number[] }) {
  return <div className="ref-bars" aria-label="Biá»ƒu Ä‘á»“ cá»™t">{values.map((v, i) => <span key={i} style={{ height: Math.max(12, v * 4) + "px" }}/>)}</div>;
}

function MiniLine({ tone = "green" }: { tone?: string }) {
  const points = [[5,105],[55,78],[100,95],[145,55],[190,82],[240,42],[285,71],[330,48],[380,30],[425,74],[495,38]];
  return <div className={"ref-line " + tone}><svg viewBox="0 0 500 145" role="img" aria-label="Biá»ƒu Ä‘á»“ xu hÆ°á»›ng"><polyline points={points.map((p) => p.join(",")).join(" ")}/>{points.map(([x,y],i)=><circle key={i} cx={x} cy={y} r="4"/>)}</svg></div>;
}

export function ReferenceEmployees({ store }: { store: ReferenceStore }) {
  const { employees, reload } = useEmployees(store.id);
  const [query, setQuery] = useState(""); const [tab, setTab] = useState("ALL");
  const [open, setOpen] = useState(false); const [editing, setEditing] = useState<Employee | null>(null);
  con×ßzŞÚ$z{-®éÜj×Âö#ãÂ÷FCãÇFCçµ7G&–ær‡&V6÷&BæFFææ÷FRÇÂ.(	B"—ÓÂ÷FCãÇFCå^ª6âÌ;Ò>ºÖŒ:æsÂ÷FCãÇFCãÆ'WGFöâF—6&ÆVC×¶Æö6¶VBÇÂÆöF–ærÇÂf–æÆ—¦–ærÇÂFF—47W'&VçBÇÂFVÆWF–ætF§W7FÖVçD–BÓÒçVÆÇÒ6Æ74æÖSÒ&FævW"ÖÆ–æ²"öä6Æ–6³×²‚’Óâfö–B&VÖ÷fR‡&V6÷&Bæ–B—Óç¶FVÆWF–ætF§W7FÖVçD–BÓÓÒ&V6÷&Bæ–Bò,IærŒ;6(
b"¢%Œ;6'ÓÂö'WGFöããÂ÷FCãÂ÷G#â’¢ÇG#ãÇFB6öÅ7ã×³wÒ6Æ74æÖSÒ&V×G’Ö6VÆÂ#ä6ŒkŒ:B6–æ‚ºR>ªW†ş«v2FŒk¹öærG&öær¾»2ãÂ÷FCãÂ÷G#çĞ¢Â÷F&öG“ãÂ÷F&ÆSãÂöF—cãÂ÷6V7F–öãàĞ Ğ¢ÆF—b6Æ74æÖSÒ'&VbÖ6†'B×&÷r#ãÆ'F–6ÆR6Æ74æÖSÒ&6†'BÖ6&BFöçWB×6ÖÆÂ#ãÆF—b6Æ74æÖSÒ'&VbÖFöçWB—&öÆÂ#ãÆ#ç¶ÖöæW’‡7VÖÖ'“òçF÷FÄf–Æ&ÆU’óò7VÖÖ'“òçF÷FÅ’óò—ÓÂö#ãÇ6ÖÆÃä<;&âª6’6†“Â÷6ÖÆÃãÂöF—cãÆF—cãÆ#ä<j>ªWR6†’G.ª3Âö#ãÇäÌkjærF†Vòv¹ÒF»2N«óÂ÷ãÇìI:2G.º²<:2¶†şª6âº–ærÌkjæsÂ÷ãÂöF—cãÂö'F–6ÆSãÆ'F–6ÆR6Æ74æÖSÒ&6†'BÖ6&B#ãÆƒ3åF¹ær¼:¢v¹ÒÌ:ÒF†Vòæ|:“Âöƒ3ãÄÖ–æ”&'2óãÂö'F–6ÆSãÆ'F–6ÆR6Æ74æÖSÒ&6†'BÖ6&BV–6²×F÷FÂ#ãÆƒ3åL;6ÒNª÷Bæ†æƒÂöƒ3ãÇãÇ7ãäÌkjærF»2æªÖãÂ÷7ããÆ#ç¶ÖöæW’‡7VÖÖ'“òçF÷FÄ&6U6Æ'’óò—ÓÂö#ãÂ÷ãÇãÇ7ãåºR>ªWÂ÷7ããÆ#ç¶ÖöæW’‡F÷FÄÆÆ÷væ6R—ÓÂö#ãÂ÷ãÇãÇ7ãåFŒk¹öær¶Œ:3Â÷7ããÆ#ç¶ÖöæW’‡7VÖÖ'“òçF÷FÄÖçVÄ&öçW2óò—ÓÂö#ãÂ÷ãÇãÇ7ãåFŒk¹öærµ“Â÷7ããÆ#ç¶ÖöæW’‡7VÖÖ'“òçF÷FÄ·”&öçW2óò—ÓÂö#ãÂ÷ãÇãÇ7ãìI:2º–ærò6¹Ò6†“Â÷7ããÆ#ç¶ÖöæW’‡7VÖÖ'“òçF÷FÅ6Æ'”Gfæ6U&W6W'fVBóò—ÓÂö#ãÂ÷ãÇãÇ7ãä<;&â¶ª2NºVæsÂ÷7ããÆ#ç¶ÖöæW’‡7VÖÖ'“òçF÷FÄf–Æ&ÆU’óò7VÖÖ'“òçF÷FÅ’óò—ÓÂö#ãÂ÷ãÇãÇ7ãåN¹VærFŒk¹öæsÂ÷7ããÆ#ç¶ÖöæW’‡F÷FÄ&öçW2—ÓÂö#ãÂ÷ãÂö'F–6ÆSãÂöF—cà Ğ¢¶÷VâbbF§W7FÖVçE66÷RbbF§W7FÖVçD—47W'&VçBbbÆF—b&Vc×·—&öÆÄ&6¶G&÷&VgÒ6Æ74æÖSÒ&ÖöFÂÖ&6¶G&÷#ãÆf÷&Ò&Vc×·—&öÆÄF–Æöu&VgÒ6Æ74æÖSÒ&ÖöFÂ—&öÆÂÖ7F–öâÖÖöFÂ"&öÆSÒ&F–Æör"&–ÖÖöFÃÒ'G'VR"&–ÖÆ&VÆÆVF'“Ò'—&öÆÂÖF§W7FÖVçBÖF–Æör×F—FÆR"&–Ö'W7“×·6f–ætF§W7FÖVçGÒF$–æFWƒ×²ÓÒöå7V&Ö—C×·6fWÓãÆF—b6Æ74æÖSÒ&ÖöFÂ×F—FÆR#ãÆF—cãÆƒ"–CÒ'—&öÆÂÖF§W7FÖVçBÖF–Æör×F—FÆR#ç¶¶–æBÓÓÒ$ÄÄõtä4R"ò%NªòºR>ªW"¢%NªòFŒk¹öær'ÓÂöƒ#ãÇä¶†şª6â6†’Ikº62v†’æªÖâI;¦æræŒ:&âfœ:¦âÂ>ºÖŒ:ærl:FŒ:ærÌkjæsÂ÷ãÂöF—cãÆ'WGFöâG—SÒ&'WGFöâ"&–ÖÆ&VÃÒ,I;6ær¹—F†şª’NªòºR>ªW†ş«v2FŒk¹öær"F—6&ÆVC×·6f–ætF§W7FÖVçGÒöä6Æ–6³×¶6Æ÷6TF§W7FÖVçDF–ÆöwÓãÅ‚6—¦S×³—ÒóãÂö'WGFöããÂöF—cãÆÆ&VÃäæŒ:&âfœ:¦âIkº62æªÖâ£Ç6VÆV7B&Vc×·—&öÆÄV×Æ÷–VU6VÆV7E&VgÒF—6&ÆVC×·6f–ætF§W7FÖVçGÒfÇVS×¶V×Æ÷–VT–GÒöä6†ævS×²†WfVçB’Óâ6WDV×Æ÷–VT–B†WfVçBçF&vWBçfÇVR—Óç¶V×Æ÷–VW2æÖ‚†V×Æ÷–VR’ÓâÆ÷F–öâ¶W“×¶V×Æ÷–VRæ–GÒfÇVS×¶V×Æ÷–VRæ–GÓç¶V×Æ÷–VRæ6öFWÒ+r¶V×Æ÷–VRææÖW×¶V×Æ÷–VU7FGW57Vff—‚†V×Æ÷–VRç7FGW2—ÓÂö÷F–öãâ—ÓÂ÷6VÆV7CãÂöÆ&VÃãÆÆ&VÃå>¹F¸â¶¶–æBÓÓÒ$ÄÄõtä4R"ò'ºR>ªW"¢'FŒk¹öær'Ò£Æ–çWB–çWDÖöFSÒ&çVÖW&–2"&WV—&VBF—6&ÆVC×·6f–ætF§W7FÖVçGÒfÇVS×¶Ö÷VçGÒöä6†ævS×²†WfVçB’Óâ6WDÖ÷VçB†f÷&ÖEfæD–çWB†WfVçBçF&vWBçfÇVR’—ÒÆ6V†öÆFW#Ò#"óãÇ6ÖÆÃäæª×F†VòdäBÂl:ÒNºS¢S>«Ò†¸6âF¸²RÃãÂ÷6ÖÆÃãÂöÆ&VÃãÆF—b6Æ74æÖSÒ&ÖFFR×–6¶W"Öf–VÆB#ãÇ7ãäæ|:’v†’æªÖãÂ÷7ããÄFFU–6¶W$6öçG&öÂ&–Æ&VÃÒ$æ|:’v†’æªÖâºR>ªW†ş«v2FŒk¹öær"Ö–ã×¶G¶F§W7FÖVçE66÷RçW&–öGÒÓÒÖƒ×¶G¶F§W7FÖVçE66÷RçW&–öGÒÓ3ÒF—6&ÆVC×·6f–ætF§W7FÖVçGÒfÇVS×¶FFWÒöä6†ævS×·6WDFFWÒóãÂöF—cãÆÆ&VÃäî¹–’GVær6†’£ÇFW‡F&V&WV—&VBF—6&ÆVC×·6f–ætF§W7FÖVçGÒfÇVS×¶æ÷FWÒöä6†ævS×²†WfVçB’Óâ6WDæ÷FR†WfVçBçF&vWBçfÇVR—ÒÆ6V†öÆFW#×¶¶–æBÓÓÒ$ÄÄõtä4R"ò%l:ÒNºS¢ºR>ªW6‡Wœ:¦â>ªvâ"¢%l:ÒNºS¢FŒk¹öær†ü:âFŒ:æ‚<;Færf¸v2'ÒóãÂöÆ&VÃç¶ÖW76vRbbÆF—b6Æ74æÖSÒ&f÷&ÒÖÖW76vR"&öÆSÒ&ÆW'B#ç¶ÖW76vWÓÂöF—cçÓÆF—b6Æ74æÖSÒ&ÖöFÂÖ7F–öç2#ãÆ'WGFöâG—SÒ&'WGFöâ"F—6&ÆVC×·6f–ætF§W7FÖVçGÒöä6Æ–6³×¶6Æ÷6TF§W7FÖVçDF–ÆöwÓäºw“Âö'WGFöããÆ'WGFöâ6Æ74æÖSÒ'&–Ö'’Ö'WGFöâ"F—6&ÆVC×·6f–ætF§W7FÖVçBÇÂV×Æ÷–VT–GÓç·6f–ætF§W7FÖVçBò,IærÌk^(
b"¢ÌkRG¶¶–æBÓÓÒ$ÄÄõtä4R"ò'ºR>ªW"¢'FŒk¹öær'ÖÓÂö'WGFöããÂöF—cãÂöf÷&ÓãÂöF—cçĞ¢ÂöF—cã°Ğ§ĞĞ Ğ¦gVæ7F–öâ66†fÆ÷tÖævVÖVçB‡²7F÷&RÓ¢²7F÷&S¢&VfW&Væ6U7F÷&RÒ’°Ğ¢6öç7B·&V6÷&G2Ç&VÆöGÓ×W6U&V6÷&G2‚$DôäuõD”Tâ"Ç7F÷&Ræ–B“²6öç7B¶÷VâÇ6WD÷VåÓ×W6U7FFR†fÇ6R“²6öç7B¶VF—F–ærÇ6WDVF—F–æuÓ×W6U7FFSÄ'W6–æW75&V6÷&GÆçVÆÃâ†çVÆÂ“²6öç7B·G—RÇ6WEG—UÓ×W6U7FFR‚$Ö&¶WF–ær"“²6öç7B¶Ö÷VçBÇ6WDÖ÷VçEÓ×W6U7FFR‚""“²6öç7B¶FFRÇ6WDFFUÓ×W6U7FFR‡FöF’‚’“²6öç7B¶æ÷FRÇ6WDæ÷FUÓ×W6U7FFR‚""“²6öç7B¶ÖW76vRÇ6WDÖW76vUÓ×W6U7FFR‚""“°Ğ¢6öç7BW‡G&×&V6÷&G2ç&VGV6R‚‡2Ç"“Óç2´çVÖ&W"‡"æFFæÖ÷VçCóó’Ã“¶6öç7BW‡Vç6S×7F÷&RæW‡Vç6R¶W‡G&¶6öç7B&öf—C×7F÷&Rç&WfVçVRÖW‡Vç6S²6öç7BÖ&v–ã×7F÷&Rç&WfVçVS÷&öf—B÷7F÷&Rç&WfVçVR££°Ğ¢gVæ7F–öâ&Vv–â‡&V6÷&Có¤'W6–æW75&V6÷&B—·6WDVF—F–ær‡&V6÷&CóöçVÆÂ“·6WEG—R‡&V6÷&CòçF—FÆSóò$Ö&¶WF–ær"“·6WDÖ÷VçB…7G&–ær‡&V6÷&CòæFFæÖ÷VçCóò""’“·6WDFFR…7G&–ær‡&V6÷&CòæFFæFFSó÷FöF’‚’’“·6WDæ÷FR…7G&–ær‡&V6÷&CòæFFææ÷FSóò""’“·6WDÖW76vR‚""“·6WD÷Vâ‡G'VR“·ĞĞ¢7–æ2gVæ7F–öâ6fR†WfVçC¤f÷&ÔWfVçB—¶WfVçBç&WfVçDFVfVÇB‚“·G'—¶v—B6fU&V6÷&B‡¶–C¦VF—F–æsòæ–BÆ6FVv÷'“¢$DôäuõD”Tâ"Ç7F÷&T–C§7F÷&Ræ–BÇF—FÆS§G—RÆFF§¶Ö÷VçC¤çVÖ&W"†Ö÷VçB’ÆFFRÆæ÷FW×Ò“·6WD÷Vâ†fÇ6R“¶v—B&VÆöB‚“·Ö6F6‚†W'&÷"—·6WDÖW76vR‚†W'&÷"2W'&÷"’æÖW76vR“·×ĞĞ¢7–æ2gVæ7F–öâ&VÖ÷fR†–C§7G&–ær—¶–b†v—BFVÆWFU&V6÷&B†–B’–v—B&VÆöB‚“·ĞĞ¢&WGW&âÆF—b6Æ74æÖSÒ'&VfW&Væ6RÖÖöGVÆR66†fÆ÷r×vR#ãÆF—b6Æ74æÖSÒ'&Vb×FööÆ&"#ãÆF—cãÆƒ#äL;&ærF¸ãÂöƒ#ãÇåF†VòL;V’Föæ‚F‡RÂ6†’Œ:Òl:Îº6’æ‡^ªÖâ>ºÖŒ:æsÂ÷ãÂöF—cãÆF—b6Æ74æÖSÒ'&Vb×FööÆ&"Ö7F–öç2#ãÆ–çWBG—SÒ&FFR"FVfVÇEfÇVS×·FöF’‚—ÒóãÆ'WGFöâöä6Æ–6³×²‚“Óæ77b‚&Föær×F–VâÖ7VÖ†æræ77b"Åµ²$æ|:’"Â$Æşª’6†’Œ:Ò"Â%>¹F¸â"Â$v†’6Œ;¢%ÒÂââç&V6÷&G2æÖ‡#Óåµ7G&–ær‡"æFFæFFR’Ç"çF—FÆRÄçVÖ&W"‡"æFFæÖ÷VçB’Å7G&–ær‡"æFFææ÷FR•Ò•Ò—ÓãÄF÷væÆöB6—¦S×³gÒóâ‡^ªWBW†6VÃÂö'WGFöããÆ'WGFöâ6Æ74æÖSÒ'&–Ö'’Ö'WGFöâ"öä6Æ–6³×²‚“Óæ&Vv–â‚—ÓãÅÇW26—¦S×³wÒóâFŒ:¦Ò6†’Œ:ÓÂö'WGFöããÂöF—cãÂöF—càĞ¢ÆF—b6Æ74æÖSÒ'&VbÖÖWG&–72f÷W"#ãÄÖWG&–2–6öã×´&$6†'C7ÒÆ&VÃÒ$Dôä‚D…R"fÇVS×¶ÖöæW’‡7F÷&Rç&WfVçVR—Òæ÷FSÒ.(i"ÃRR6òn¹¶’¾»2G,k¹¶2"FöæSÒ&&ÇVR"óãÄÖWG&–2–6öã×µvÆÆWD6&G7ÒÆ&VÃÒ%N¹Där4„’Œ8Ò"fÇVS×¶ÖöæW’†W‡Vç6R—Òæ÷FSÒ.(i‚Ã2R6òn¹¶’¾»2G,k¹¶2"FöæSÒ&÷&ævR"óãÄÖWG&–2–6öã×´&$6†'C7ÒÆ&VÃÒ$Îº$’ä…^ªÄâ"fÇVS×¶ÖöæW’‡&öf—B—Òæ÷FSÒ.(i‚Ã’R6òn¹¶’¾»2G,k¹¶2"óãÄÖWG&–2–6öã×´&$6†'C7ÒÆ&VÃÒ$$œ8¤âÎº$’ä…^ªÄâ"fÇVS×¶Ö&v–âçFôf—†VBƒ"’²"R'ÒFöæSÒ'W'ÆR"óãÂöF—càĞ¢ÆF—b6Æ74æÖSÒ'&VbÖ6†'B×&÷rGvò#ãÆ'F–6ÆR6Æ74æÖSÒ&6†'BÖ6&B#ãÆF—b6Æ74æÖSÒ'æVÂ×F—FÆR#ãÆƒ#äFöæ‚F‡RF†Vòæ|:“Âöƒ#ãÇ6VÆV7CãÆ÷F–öãåF†Vòæ|:“Âö÷F–öããÆ÷F–öãåF†VòFŒ:æsÂö÷F–öããÂ÷6VÆV7CãÂöF—cãÄÖ–æ”&'2fÇVW3×µ³"Ã’Ã‚ÃbÃbÃ2Ã‚ÃrÃ2Ã’Ã#Ã"ÃU×ÒóãÂö'F–6ÆSãÆ'F–6ÆR6Æ74æÖSÒ&6†'BÖ6&B#ãÆF—b6Æ74æÖSÒ'æVÂ×F—FÆR#ãÆƒ#äFöæ‚F‡RbÎº6’æ‡^ªÖâF†Vòæ|:“Âöƒ#ãÇ6VÆV7CãÆ÷F–öãåF†Vòæ|:“Âö÷F–öããÆ÷F–öãåF†VòFŒ:æsÂö÷F–öããÂ÷6VÆV7CãÂöF—cãÄÖ–æ”Æ–æRFöæSÒ&&ÇVR"óãÂö'F–6ÆSãÂöF—càĞ¢ÆF—b6Æ74æÖSÒ'&VbÖ66‚Öw&–B#ãÆ'F–6ÆR6Æ74æÖSÒ'F&ÆRÖ6&B#ãÆF—b6Æ74æÖSÒ'F&ÆRÖ†VB#ãÆƒ#äFöæ‚F‡SÂöƒ#ãÆ'WGFöâ6Æ74æÖSÒ&Æ–æ²Ö'WGFöâ#å†VÒ6†’F«÷CÂö'WGFöããÂöF—cãÇF&ÆR6Æ74æÖSÒ&FF×F&ÆR#ãÇF&öG“çµ³ƒSÃc#Ã#ƒÃ3CÃcÒæÖ‚‡fÇVRÆ–æFW‚“ÓãÇG"¶W“×¶–æFW‡ÓãÇFCç³RÖ–æFW‡ÒóRó##SÂ÷FCãÇFB6Æ74æÖSÒ&ÖöæW’Öw&VVâ#ç¶ÖöæW’‡fÇVR—ÓÂ÷FCãÇFCäæŒ:&âfœ:¦â,:âŒ:æsÂ÷FCãÂ÷G#â—ÓÂ÷F&öG“ãÂ÷F&ÆSãÂö'F–6ÆSãÆ'F–6ÆR6Æ74æÖSÒ&6†'BÖ6&BW‡Vç6RÖÆ—7B#ãÆƒ#ä6†’Œ:ÓÂöƒ#ãÇãÇ7ãä6†’Œ:Ò>¹I¸¶æƒÇ6ÖÆÃå6WGWÂI¸vâÂìk¹¶2Âv–f’Â,:2ÂŞ«wB.«æsÂ÷6ÖÆÃãÂ÷7ããÆ#ç¶ÖöæW’‡7F÷&RæW‡Vç6R—ÓÂö#ãÂ÷ãÇãÇ7ãä6†’Œ:ÒÖ&¶WF–æsÇ6ÖÆÃå^ª6ær<:òl:G'W¸âFŒ;FæsÂ÷6ÖÆÃãÂ÷7ããÆ#ç¶ÖöæW’‡&V6÷&G2æf–ÇFW"‡#Óç"çF—FÆSÓÓÒ$Ö&¶WF–ær"’ç&VGV6R‚‡2Ç"“Óç2´çVÖ&W"‡"æFFæÖ÷VçB’Ã’—ÓÂö#ãÂ÷ãÇãÇ7ãä6†’Œ:ÒŒ:B6–æ‚I:2æª×Â÷7ããÆ#ç¶ÖöæW’†W‡G&—ÓÂö#ãÂ÷ãÇ6Æ74æÖSÒ&W‡Vç6R×F÷FÂ#ãÇ7ãåN¹Vær6†’Œ:ÓÂ÷7ããÆ#ç¶ÖöæW’†W‡Vç6R—ÓÂö#ãÂ÷ãÂö'F–6ÆSãÆ'F–6ÆR6Æ74æÖSÒ&6†'BÖ6&BFöçWB×6ÖÆÂfW'F–6Â#ãÆF—b6Æ74æÖSÒ'&VbÖFöçWB66‚#ãÆ#ç¶ÖöæW’‡&öf—B—ÓÂö#ãÇ6ÖÆÃäÎº6’æ‡^ªÖãÂ÷6ÖÆÃãÂöF—cãÇäÎº6’æ‡^ªÖâÒFöæ‚F‡R(‰"N¹Vær6†’Œ:ÓÂ÷ãÂö'F–6ÆSãÂöF—càĞ¢Ç6V7F–öâ6Æ74æÖSÒ'F&ÆRÖ6&B#ãÆF—b6Æ74æÖSÒ'F&ÆRÖ†VB#ãÆƒ#ä6†’Œ:Ò>¹I¸¶æ‚~ªvâI:'“Âöƒ#ãÇ7ãç·&V6÷&G2æÆVæwF‡Ò¶†şª6âŒ:B6–æƒÂ÷7ããÂöF—cãÆF—b6Æ74æÖSÒ&FF×F&ÆR×w&#ãÇF&ÆR6Æ74æÖSÒ&FF×F&ÆR#ãÇF†VCãÇG#ãÇFƒäæ|:“Â÷FƒãÇFƒäÆşª’6†’Œ:ÓÂ÷FƒãÇFƒå>¹F¸ãÂ÷FƒãÇFƒäv†’6Œ;£Â÷FƒãÇFƒäæ|k¹Ö’NªóÂ÷FƒãÇFƒåF†òL:3Â÷FƒãÂ÷G#ãÂ÷F†VCãÇF&öG“ç·&V6÷&G2æÆVæwFƒ÷&V6÷&G2æÖ‡&V6÷&CÓãÇG"¶W“×·&V6÷&Bæ–GÓãÇFCçµ7G&–ær‡&V6÷&BæFFæFFR—ÓÂ÷FCãÇFCãÆ#ç·&V6÷&BçF—FÆWÓÂö#ãÂ÷FCãÇFB6Æ74æÖSÒ&ÖöæW’Ö÷&ævR#ç¶ÖöæW’„çVÖ&W"‡&V6÷&BæFFæÖ÷VçB’—ÓÂ÷FCãÇFCçµ7G&–ær‡&V6÷&BæFFææ÷FWÇÂ.(	B"—ÓÂ÷FCãÇFCå^ª6âÌ;Ò>ºÖŒ:æsÂ÷FCãÇFCãÆF—b6Æ74æÖSÒ'&÷rÖ7F–öç2#ãÆ'WGFöâöä6Æ–6³×²‚“Óæ&Vv–â‡&V6÷&B—ÓãÄVF—C26—¦S×³WÒóãÂö'WGFöããÆ'WGFöâ6Æ74æÖSÒ&FævW""öä6Æ–6³×²‚“Óç&VÖ÷fR‡&V6÷&Bæ–B—ÓãÅG&6ƒ"6—¦S×³WÒóãÂö'WGFöããÂöF—cãÂ÷FCãÂ÷G#â“£ÇG#ãÇFB6öÅ7ã×³gÒ6Æ74æÖSÒ&V×G’Ö6VÆÂ#ä6Œkæª×6†’Œ:ÒŒ:B6–æ‚ãÂ÷FCãÂ÷G#çÓÂ÷F&öG“ãÂ÷F&ÆSãÂöF—cãÂ÷6V7F–öãàĞ¢¶÷VâbcÆF—b6Æ74æÖSÒ&ÖöFÂÖ&6¶G&÷#ãÆf÷&Ò6Æ74æÖSÒ&ÖöFÂ"öå7V&Ö—C×·6fWÓãÆF—b6Æ74æÖSÒ&ÖöFÂ×F—FÆR#ãÆF—cãÆƒ#ç¶VF—F–æsò$>ª×æª×B6†’Œ:Ò#¢%FŒ:¦Ò6†’Œ:Ò'ÓÂöƒ#ãÇäNºòÆ¸wRIkº62v†’&œ:¦ær6†ò·7F÷&RææÖWÓÂ÷ãÂöF—cãÆ'WGFöâG—SÒ&'WGFöâ"öä6Æ–6³×²‚“Óç6WD÷Vâ†fÇ6R—ÓãÅ‚6—¦S×³—ÒóãÂö'WGFöããÂöF—cãÆÆ&VÃäÆşª’6†’Œ:ÓÇ6VÆV7BfÇVS×·G—WÒöä6†ævS×²†R“Óç6WEG—R†RçF&vWBçfÇVR—ÓãÆ÷F–öãäÖ&¶WF–æsÂö÷F–öããÆ÷F–öãå6WGWÂö÷F–öããÆ÷F–öãäŞ«wB.«æsÂö÷F–öããÆ÷F–öãìI¸vãÂö÷F–öããÆ÷F–öãäìk¹¶3Âö÷F–öããÆ÷F–öãåv–f“Âö÷F–öããÆ÷F–öãå,:3Âö÷F–öããÆ÷F–öãä¶Œ:3Âö÷F–öããÂ÷6VÆV7CãÂöÆ&VÃãÆF—b6Æ74æÖSÒ&f÷&ÒÖw&–BGvò#ãÆÆ&VÃå>¹F¸â£Æ–çWBG—SÒ&çVÖ&W""Ö–ãÒ#"&WV—&VBfÇVS×¶Ö÷VçGÒöä6†ævS×²†R“Óç6WDÖ÷VçB†RçF&vWBçfÇVR—ÒóãÂöÆ&VÃãÆÆ&VÃäæ|:’6†“Æ–çWBG—SÒ&FFR"fÇVS×¶FFWÒöä6†ævS×²†R“Óç6WDFFR†RçF&vWBçfÇVR—ÒóãÂöÆ&VÃãÂöF—cãÆÆ&VÃäî¹–’GVær6†’£ÇFW‡F&V&WV—&VBfÇVS×¶æ÷FWÒöä6†ævS×²†R“Óç6WDæ÷FR†RçF&vWBçfÇVR—ÒóãÂöÆ&VÃç¶ÖW76vRbcÆF—b6Æ74æÖSÒ&f÷&ÒÖÖW76vR#ç¶ÖW76vWÓÂöF—cçÓÆF—b6Æ74æÖSÒ&ÖöFÂÖ7F–öç2#ãÆ'WGFöâG—SÒ&'WGFöâ"öä6Æ–6³×²‚“Óç6WD÷Vâ†fÇ6R—Óäºw“Âö'WGFöããÆ'WGFöâ6Æ74æÖSÒ'&–Ö'’Ö'WGFöâ#äÌkR6†’Œ:ÓÂö'WGFöããÂöF—cãÂöf÷&ÓãÂöF—cçĞĞ¢ÂöF—cã°Ğ§ĞĞ Ğ¦gVæ7F–öâ&W÷'DÖævVÖVçB‡²7F÷&RÓ¢²7F÷&S¢&VfW&Væ6U7F÷&RÒ’°Ğ¢6öç7B¶V×Æ÷–VW7Ó×W6TV×Æ÷–VW2‡7F÷&Ræ–B“²6öç7B·6†–gG7Ó×W6U6†–gE6W76–öç2‡7F÷&Ræ–B“²6öç7B—&öÆÃ×W6U&V6÷&G2‚$ÅTôäuõD…Tôär"Ç7F÷&Ræ–B’ç&V6÷&G3²6öç7B·F"Ç6WEF%Ó×W6U7FFR‚%N¹VærVâ"“²6öç7B¶g&öÒÇ6WDg&öÕÓ×W6U7FFR‡FöF’‚’ç6Æ–6RƒÃ‚’²#"“²6öç7B·FòÇ6WEFõÓ×W6U7FFR‡FöF’‚’“²6öç7B·W&–öE—&öÆÂÇ6WEW&–öE—&öÆÅÓ×W6U7FFSÅ—&öÆÅ7VÖÖ'—ÆçVÆÃâ†çVÆÂ“°Ğ¢W6TVffV7B‚‚“Óç¶6öç7BW&–öCÖg&öÒç6Æ–6RƒÃr“¶fWF6‚†ö’÷—&öÆÃ÷7F÷&T–CÒG¶Væ6öFUU$”6ö×öæVçB‡7F÷&Ræ–B—ÒgW&–öCÒG¶Væ6öFUU$”6ö×öæVçB‡W&–öB—Ö’çF†Vâ‡#Óç"æ§6öâ‚’’çF†Vâ†FFÓç6WEW&–öE—&öÆÂ†FFç7VÖÖ'“óöçVÆÂ’“·ÒÅ¶g&öÒÇ7F÷&Ræ–EÒ“°Ğ¢6öç7B6ö×ÆWFVC×6†–gG2æf–ÇFW"‡3Óç2æVæFVEöB“²6öç7B†÷W'3Ö6ö×ÆWFVBç&VGV6R‚‡7VÒÇ2“Óç7VÒ·6W76–öå6V6öæG2‡2’ó3cÃ“²6öç7B6†–gEvvW3Ö6ö×ÆWFVBç&VGV6R‚‡7VÒÇ2“Óç7VÒ²‡6W76–öå6V6öæG2‡2’ó3c’§6W76–öå&FR‡2’Ã“²6öç7BvvW3×W&–öE—&öÆÃòçF÷FÄ&6U6Æ'“ó÷6†–gEvvW3²6öç7B&V6÷&DW‡G&3×—&öÆÂç&VGV6R‚‡7VÒÇ"“Óç7VÒ´çVÖ&W"‡"æFFæÖ÷VçCóó’Ã“²6öç7BW‡G&3×W&–öE—&öÆÂòW&–öE—&öÆÂçF÷FÅF–µFö´ÆÆ÷væ6R·W&–öE—&öÆÂçF÷FÅ7W÷'DÆÆ÷væ6R·W&–öE—&öÆÂçF÷FÄÖçVÄÆÆ÷væ6R·W&–öE—&öÆÂçF÷FÄÖçVÄ&öçW2·W&–öE—&öÆÂçF÷FÄ·”&öçW2¢&V6÷&DW‡G&3°¢&WGW&âÆF—b6Æ74æÖSÒ'&VfW&Væ6RÖÖöGVÆR&W÷'B×vR#ãÆF—b6Æ74æÖSÒ'&Vb×FööÆ&"#ãÆF—cãÆƒ#ä,:ò<:òF¹ær¼:£Âöƒ#ãÇåN¹Værº7NºòÆ¸wR†şªBI¹–ær>ºv>ºÖŒ:æsÂ÷ãÂöF—cãÆF—b6Æ74æÖSÒ'&Vb×FööÆ&"Ö7F–öç2#ãÆ–çWBG—SÒ&FFR"fÇVS×¶g&ö×Òöä6†ævS×²†R“Óç6WDg&öÒ†RçF&vWBçfÇVR—ÒóãÇ7ãî(‰#Â÷7ããÆ–çWBG—SÒ&FFR"fÇVS×·F÷Òöä6†ævS×²†R“Óç6WEFò†RçF&vWBçfÇVR—ÒóãÆ'WGFöâ6Æ74æÖSÒ'&–Ö'’Ö'WGFöâ"öä6Æ–6³×²‚“Óæ77b‚&&òÖ6òÖ7VÖ†æræ77b"Åµ²$6¸’>¹"Â$vœ:G.¸²%ÒÅ²$æŒ:&âfœ:¦â"ÆV×Æ÷–VW2æÆVæwF…ÒÅ²%N¹Værv¹Ò"Æ†÷W'2çFôf—†VBƒ"•ÒÅ²$Ìkjær"ÄÖF‚ç&÷VæB‡vvW2•ÒÅ²%FŒk¹öær÷ºR>ªW"ÆW‡G&5ÒÅ²$Föæ‚F‡R"Ç7F÷&Rç&WfVçVUÕÒ—ÓãÄF÷væÆöB6—¦S×³gÒóâ‡^ªWB,:ò<:óÂö'WGFöããÂöF—cãÂöF—càĞ¢ÆF—b6Æ74æÖSÒ'&Vb×&W÷'B×F'2#çµ²%N¹VærVâ"Â$6ªVÒ<;Fær"Â$ÌkjærFŒk¹öær"Â$6Ì:Òf¸v2"Â$æŒ:&âfœ:¦â"Â$6†’F«÷B%ÒæÖ†—FVÓÓãÆ'WGFöâ¶W“×¶—FV×Ò6Æ74æÖS×·F#ÓÓÖ—FVÓò&7F—fR#¢"'Òöä6Æ–6³×²‚“Óç6WEF"†—FVÒ—Óç¶—FV×ÓÂö'WGFöãâ—ÓÂöF—càĞ¢ÆF—b6Æ74æÖSÒ'&VbÖÖWG&–72f—fR#ãÄÖWG&–2–6öã×µW6W'5&÷VæGÒÆ&VÃÒ%N¹VæræŒ:&âfœ:¦â"fÇVS×¶V×Æ÷–VW2æÆVæwF‚²"æ|k¹Ö’'Òæ÷FSÒ%F†VòNºòÆ¸wR†¸vâNª’"óãÄÖWG&–2–6öã×´6Æö6³7ÒÆ&VÃÒ%N¹Værv¹ÒÌ:Ò"fÇVS×¶†÷W'2çFôf—†VBƒ"’²"v¹Ò'Òæ÷FSÒ%F†Vò¾»2I:26¸Öâ"óãÄÖWG&–2–6öã×µvÆÆWD6&G7ÒÆ&VÃÒ%N¹VærÌkjær>º–ær"fÇVS×¶ÖöæW’‡vvW2—ÒóãÄÖWG&–2–6öã×´v–gGÒÆ&VÃÒ%N¹VærFŒk¹öær"fÇVS×¶ÖöæW’†W‡G&2—ÒóãÄÖWG&–2–6öã×µvÆÆWD6&G7ÒÆ&VÃÒ%N¹VærÌkjæræªÖâ"fÇVS×¶ÖöæW’‡vvW2¶W‡G&2—ÒóãÂöF—cà¢ÆF—b6Æ74æÖSÒ'&Vb×&W÷'BÖ6†'G2#ãÆ'F–6ÆR6Æ74æÖSÒ&6†'BÖ6&B#ãÆƒ#äv¹ÒÌ:Òf¸v2F†Vòæ|:“Âöƒ#ãÄÖ–æ”&'2óãÂö'F–6ÆSãÆ'F–6ÆR6Æ74æÖSÒ&6†'BÖ6&B#ãÆƒ#äFöæ‚F‡RF†Vòæ|:“Âöƒ#ãÄÖ–æ”Æ–æRóãÂö'F–6ÆSãÆ'F–6ÆR6Æ74æÖSÒ&6†'BÖ6&BFöçWB×6ÖÆÂfW'F–6Â#ãÆƒ#ä<j>ªWRÌkjæræªÖãÂöƒ#ãÆF—b6Æ74æÖSÒ'&VbÖFöçWB&W÷'B#ãÆ#ç¶ÖöæW’‡vvW2¶W‡G&2—ÓÂö#ãÇ6ÖÆÃåN¹VærÌkjæræªÖãÂ÷6ÖÆÃãÂöF—cãÂö'F–6ÆSãÂöF—cà¢ÆF—b6Æ74æÖSÒ'&Vb×&W÷'BÖ&÷GFöÒ#ãÇ6V7F–öâ6Æ74æÖSÒ'F&ÆRÖ6&B#ãÆF—b6Æ74æÖSÒ'F&ÆRÖ†VB#ãÆƒ#ç·F"ÓÓÒ%N¹VærVâ"ò%F¹ær¼:¢F†VòæŒ:&âfœ:¦â"¢$6†’F«÷B"²F"çFôÆö6ÆTÆ÷vW$66R‚'f’"—ÓÂöƒ#ãÂöF—cãÆF—b6Æ74æÖSÒ&FF×F&ÆR×w&#ãÇF&ÆR6Æ74æÖSÒ&FF×F&ÆR#ãÇF†VCãÇG#ãÇFƒäæŒ:&âfœ:¦ãÂ÷FƒãÇFƒåN¹Værv¹ÒÌ:ÓÂ÷FƒãÇFƒäÌkjær>º–æsÂ÷FƒãÇFƒåFŒk¹öæsÂ÷FƒãÇFƒåºR>ªWÂ÷FƒãÇFƒäÌkjæræªÖãÂ÷FƒãÂ÷G#ãÂ÷F†VCãÇF&öG“ç²†V×Æ÷–VW2æÆVæwFƒöV×Æ÷–VW3§6×ÆUV÷ÆRç6Æ–6RƒÃ2’æÖ‚‡Æ’“Óâ‡¶–C¢'2"¶’ÆæÖS§³ÒÇ÷6—F–öã§³ÒÆ†÷W&Ç•÷&FS£#Ò’’’æÖ‚†V×Æ÷–VRÆ–æFW‚“Óç¶6öç7BV×Æ÷–VT†÷W'3Õ³sRãRÃc‚ÃcbãUÕ¶–æFW‚S5Ó¶6öç7B&6SÖV×Æ÷–VT†÷W'2¦V×Æ÷–VRæ†÷W&Ç•÷&FS¶6öç7BW‡G&×—&öÆÂæf–ÇFW"‡#Óç"æFFæV×Æ÷–VT–CÓÓÖV×Æ÷–VRæ–B’ç&VGV6R‚‡2Ç"“Óç2´çVÖ&W"‡"æFFæÖ÷VçB’Ã“·&WGW&âÇG"¶W“×¶V×Æ÷–VRæ–GÓãÇFCãÅW'6öâæÖS×¶V×Æ÷–VRææÖWÒ÷6—F–öã×¶V×Æ÷–VRç÷6—F–öçÒóãÂ÷FCãÇFCç¶V×Æ÷–VT†÷W'2çFôf—†VBƒ"—ÓÂ÷FCãÇFCç¶ÖöæW’†&6R—ÓÂ÷FCãÇFB6Æ74æÖSÒ&ÖöæW’Öw&VVâ#ç¶ÖöæW’†W‡G&—ÓÂ÷FCãÇFCç¶ÖöæW’ƒ—ÓÂ÷FCãÇFB6Æ74æÖSÒ&ÖöæW’Öw&VVâ#ãÆ#ç¶ÖöæW’†&6R¶W‡G&³—ÓÂö#ãÂ÷FCãÂ÷G#çÒ—ÓÂ÷F&öG“ãÂ÷F&ÆSãÂöF—cãÂ÷6V7F–öããÆ6–FR6Æ74æÖSÒ&6†'BÖ6&B#ãÆƒ#åF¹ær¼:¢6Ì:Òf¸v3Âöƒ#çµ²$6+rc"ÃSv¹Ò"Â$6"+rsÃv¹Ò"Â$62+rsbÃSv¹Ò%ÒæÖ‚‡FW‡BÆ–æFW‚“ÓãÆF—b6Æ74æÖSÒ'&öw&W72×&÷r"¶W“×·FW‡GÓãÇ7ãç·FW‡GÓÂ÷7ããÆ“ãÆ"7G–ÆS×··v–GFƒ¥³3Ã3BÃ3eÕ¶–æFW…Ò²"R'×ÒóãÂö“ãÇ7G&öæsçµ³#’ã‚Ã32ã‚Ã3bãEÕ¶–æFW…×ÒSÂ÷7G&öæsãÂöF—câ—ÓÂö6–FSãÂöF—càĞ¢ÆF—b6Æ74æÖSÒ'&W÷'B×&öf—BÖæ÷FR#ãÄ6†V6´6—&6ÆS"6—¦S×³‡ÒóâNºòÆ¸wR·F"çFôÆö6ÆTÆ÷vW$66R‚'f’"—Ò>ºv·7F÷&RææÖWÒG&öær¾»2¶g&ö×Ò(i"·F÷Ò+rFöæ‚F‡RÆ#ç¶ÖöæW’‡7F÷&Rç&WfVçVR—ÓÂö#â+rÎº6’æ‡^ªÖâÆ#ç¶ÖöæW’‡7F÷&Rç&öf—B—ÓÂö#ãÂöF—càĞ¢ÂöF—cã°Ğ§ĞĞ 