export default function SupportTag({ supporting, sourceStoreName }: {
  supporting?: boolean | number; sourceStoreName?: string | null;
}) {
  if (!supporting) return null;
  return <span className="support-employee-tag">Nhân viên hỗ trợ<span>Từ {sourceStoreName || "cửa hàng chính"}</span></span>;
}
