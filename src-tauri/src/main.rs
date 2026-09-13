// 角色世界 · 桌面端入口
//
// Android / iOS 不加载可执行文件，只加载动态库 —— 所以真正的实现（命令与 `run()`）
// 全在 `src/lib.rs`，这里只负责桌面端的窗口与入口。改命令请改 `lib.rs`。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    roleworld::run()
}
