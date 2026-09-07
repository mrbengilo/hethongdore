import { notifyAction } from "./action-feedback";

type CsvCell = string | number | null | undefined;

export function csvContent(rows: CsvCell[][]) {
  return "\uFEFF" + rows.map((row) => row.map((value) => {
    const raw = String(value ?? "");
    const safe = typeof value === "string" && /^[\s]*[=+\-@]/u.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  }).join(",")).join("\r\n");
}

export function exportCsvFile(filename: string, rows: CsvCell[][]) {
  const url = URL.createObjectURL(new Blob([csvContent(rows)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  notifyAction(`Đã tạo tệp ${filename}.`);
}
