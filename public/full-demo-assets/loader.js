(async function () {
  function showError(error) {
    var root = document.getElementById("app");
    if (root) {
      root.innerHTML = '<main style="min-height:100vh;display:grid;place-content:center;padding:28px;font-family:Arial,sans-serif;background:#f5f8f6;color:#8f3030;text-align:center"><section style="max-width:560px;background:#fff;border:1px solid #efcaca;border-radius:18px;padding:28px;box-shadow:0 16px 45px rgba(0,0,0,.1)"><h2 style="margin-top:0">Không thể tải hệ thống DORE</h2><p style="color:#555;line-height:1.55">Dữ liệu ứng dụng tải chưa đầy đủ. Hãy nhấn nút bên dưới để tải lại bản mới nhất.</p><pre style="white-space:pre-wrap;word-break:break-word;background:#fff3f3;padding:10px;border-radius:8px;font-size:11px">' + String(error) + '</pre><button onclick="location.reload()" style="border:0;border-radius:9px;padding:12px 18px;background:#0b7f3c;color:#fff;font-weight:800;cursor:pointer">TẢI LẠI TRANG</button></section></main>';
    }
    console.error(error);
  }

  try {
    var script = document.currentScript;
    if (!script || !script.src) throw new Error("Không xác định được đường dẫn bộ tải.");
    var baseUrl = new URL(".", script.src);
    var files = ["chunk01.js", "chunk02.js", "chunk03.js", "chunk04.js", "chunk05.js"];
    var payloads = await Promise.all(files.map(async function (file) {
      var response = await fetch(new URL(file, baseUrl), { cache: "no-store" });
      if (!response.ok) throw new Error("Không tải được " + file + " (HTTP " + response.status + ")");
      var text = (await response.text()).trim();
      var marker = '+"';
      var start = text.indexOf(marker);
      if (start < 0) throw new Error(file + " không đúng định dạng dữ liệu.");
      var payload = text.slice(start + marker.length).trim();
      if (payload.endsWith('";')) payload = payload.slice(0, -2);
      else if (payload.endsWith('"')) payload = payload.slice(0, -1);
      if (!/^[A-Za-z0-9+/=]+$/.test(payload)) throw new Error(file + " chứa dữ liệu không hợp lệ.");
      return payload;
    }));

    var binary = atob(payloads.join(""));
    var bytes = Uint8Array.from(binary, function (character) {
      return character.charCodeAt(0);
    });
    var source = new TextDecoder().decode(bytes);
    (0, eval)(source);
  } catch (error) {
    showError(error);
  }
})();
