// Some restricted Windows runners cannot resolve os.userInfo(), which tsx
// uses only to name its temporary pipe directory. A deterministic uid keeps
// the test runner usable without changing application behavior.
if (process.platform === "win32" && typeof process.geteuid !== "function") {
  Object.defineProperty(process, "geteuid", { value: () => 0 });
}
