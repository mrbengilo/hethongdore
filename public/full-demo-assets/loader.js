(function () {
  try {
    var encoded = window.__DORE_APP || "";
    if (!encoded) throw new Error("Không nhận được dữ liệu ứng dụng.");
    var binary = atob(encoded);
    var bytes = Uint8Array.from(binary, function (character) {
      return character.charCodeAt(0);
    });
    var source = new TextDecoder().decode(bytes);
    (0, eval)(source);
  } catch (error) {
    var root = document.getElementById("app");
    if (root) {
      root.innerHTML = '<main style="min-height:100vh;display:grid;place-content:center;padding:28px;font-family:Arial,sans-serif;background:#f5f8f6;color:#8f3030;text-align:center"><section style="max-width:560px;background:#fff;border:1px solid #efcaca;border-radius:18px;padding:28px;box-shadow:0 16px 45px rgba(0,0,0,.1)"><h2 style="margin-top:0">Không thể tải hệ thống DORE</h2><p style="color:#555;line-height:1.55">Dữ liệu ứng dụng tải chưa đầy đủ. Hãy nhấn nút bên dưới để tải lại bản mới nhất.</p><pre style="white-space:pre-wrap;word-break:break-word;background:#fff3f3;padding:10px;border-radius:8px;font-size:11px">' + String(error) + '</pre><button onclick="location.reload()" style="border:0;border-radius:9px;padding:12px 18px;background:#0b7f3c;color:#fff;font-weight:800;cursor:pointer">TẢI LẠI TRANG</button></section></main>';
    }
    console.error(error);
  }
})();
