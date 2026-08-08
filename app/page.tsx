"use client";

/* eslint-disable @next/next/no-img-element -- Ảnh thương hiệu tĩnh do người dùng cung cấp và được phục vụ nội bộ. */

import { FormEvent, useEffect, useState } from "react";
import { Eye, EyeOff, LockKeyhole, ShieldCheck, UserRound } from "lucide-react";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me").then((response) => response.ok ? response.json() : null).then((data) => {
      if (data?.user?.role === "MANAGER") window.location.href = "/manager";
      if (data?.user?.role === "EMPLOYEE") window.location.href = "/employee";
    }).catch(() => undefined);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password, remember }) });
      const data = await response.json();
      if (!response.ok) setMessage(data.message ?? "Không thể đăng nhập.");
      else window.location.href = data.redirect;
    } catch {
      setMessage("Không thể kết nối hệ thống. Vui lòng thử lại.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-hero">
        <div className="brand-lockup"><div className="brand-mark"><img className="brand-logo-image" src="/dore-logo.jpg" alt="Logo DORE Quản Lý" width={1254} height={1254}/></div><div><strong>DORE</strong><span>đồ si đồng giá</span></div></div>
        <div className="hero-copy">
          <p className="eyebrow">DORE ĐỒ SI ĐỒNG GIÁ 20K</p>
          <h1>ĐỒ ĐẸP GIÁ RẺ</h1>
          <p className="hero-subtitle">Trang quản lý DORE</p>
        </div>
        <div className="store-scene" aria-hidden="true">
          <div className="hanger-rail"><i/><i/><i/><i/><i/></div>
          <div className="shopping-bag"><b>DORE</b><span>20K</span></div>
          <div className="price-board"><b>ĐỒ ĐẸP<br/>GIÁ RẺ</b><strong>20K</strong></div>
        </div>
        <p className="login-copyright">© 2026 DORE · Quản lý bán hàng thông minh</p>
      </section>
      <section className="login-panel-wrap">
        <form className="login-panel" onSubmit={submit}>
          <div className="login-logo"><img className="brand-logo-image" src="/dore-logo.jpg" alt="Logo DORE Quản Lý" width={1254} height={1254}/></div>
          <h2>Chào mừng bạn quay trở lại!</h2>
          <p className="muted">Đăng nhập để tiếp tục quản lý cửa hàng</p>
          <label>Tên đăng nhập<div className="login-input"><UserRound size={19}/><input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Nhập tên đăng nhập" autoComplete="username" required /></div></label>
          <label>Mật khẩu<div className="password-field login-input"><LockKeyhole size={19}/><input value={password} onChange={(e) => setPassword(e.target.value)} type={showPassword ? "text" : "password"} placeholder="Nhập mật khẩu" autoComplete="current-password" required/><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label="Hiện hoặc ẩn mật khẩu">{showPassword ? <EyeOff size={20}/> : <Eye size={20}/>}</button></div></label>
          <div className="login-options"><label className="check-label"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)}/> Ghi nhớ đăng nhập</label><button type="button" className="text-button" onClick={() => setMessage("Vui lòng liên hệ quản lý hệ thống để đặt lại mật khẩu an toàn.")}>Quên mật khẩu?</button></div>
          {message && <div className="form-message" role="alert">{message}</div>}
          <button className="primary-button login-submit" disabled={loading}>{loading ? "Đang xác thực..." : "Đăng nhập"}</button>
          <div className="login-divider"><span>hoặc</span></div>
          <div className="security-note"><ShieldCheck size={20}/> Bảo mật thông tin tuyệt đối</div>
        </form>
      </section>
    </main>
  );
}
