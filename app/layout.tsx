import type { Metadata } from "next";
import { headers } from "next/headers";
import "@fontsource/be-vietnam-pro/400.css";
import "@fontsource/be-vietnam-pro/500.css";
import "@fontsource/be-vietnam-pro/600.css";
import "@fontsource/be-vietnam-pro/700.css";
import "@fontsource/be-vietnam-pro/800.css";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:5173";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const imageUrl = `${protocol}://${host}/og.png`;
  const title = "DORE · Quản lý chuỗi cửa hàng";
  const description = "Hệ thống quản lý vận hành, nhân sự, dòng tiền và lương thưởng của chuỗi cửa hàng DORE.";
  return {
    title,
    description,
    openGraph: { title, description, type: "website", locale: "vi_VN", images: [{ url: imageUrl, width: 1680, height: 945, alt: "DORE · Quản lý chuỗi cửa hàng" }] },
    twitter: { card: "summary_large_image", title, description, images: [imageUrl] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="vi"><body>{children}</body></html>;
}
