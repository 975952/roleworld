// 角色世界 · 桌面端外壳
//
// 前端 (`app/`) 与网页版是同一份代码；这里只补一件网页做不到的事：
// **把数据存成磁盘上看得见的文件**，而不是浏览器数据库。
//
// 之所以不用 Tauri 的 fs 插件，而是自己开这几个命令：fs 插件要在 capabilities 里
// 配置一长串路径通配符，容易配错、也容易被前端任意读写。这里把范围钉死在
// 应用数据目录内，文件名做白名单校验，前端只能碰自己的数据。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::Manager;

/// 把前端传来的相对名字解析到应用数据目录内，并拒绝任何越界写法。
fn resolve(root: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() {
        return Err("文件名不能为空".into());
    }
    let relative = Path::new(name);
    for component in relative.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err(format!("非法路径：{name}")),
        }
    }
    if relative.is_absolute() {
        return Err(format!("非法路径：{name}"));
    }
    Ok(root.join(relative))
}

fn data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?
        .join("data");
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建数据目录：{error}"))?;
    Ok(dir)
}

#[tauri::command]
fn rw_read_text(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    let path = resolve(&data_root(&app)?, &name)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取失败 {name}：{error}")),
    }
}

#[tauri::command]
fn rw_write_text(app: tauri::AppHandle, name: String, contents: String) -> Result<(), String> {
    let path = resolve(&data_root(&app)?, &name)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))?;
    }
    // 先写临时文件再改名：中途崩溃不会留下半截文件。
    let temp = path.with_extension("tmp-write");
    fs::write(&temp, contents).map_err(|error| format!("写入失败 {name}：{error}"))?;
    fs::rename(&temp, &path).map_err(|error| format!("写入失败 {name}：{error}"))
}

#[tauri::command]
fn rw_read_binary(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    let path = resolve(&data_root(&app)?, &name)?;
    match fs::read(&path) {
        Ok(bytes) => Ok(Some(BASE64.encode(bytes))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取失败 {name}：{error}")),
    }
}

#[tauri::command]
fn rw_write_binary(app: tauri::AppHandle, name: String, base64: String) -> Result<(), String> {
    let path = resolve(&data_root(&app)?, &name)?;
    let bytes = BASE64
        .decode(base64.as_bytes())
        .map_err(|error| format!("数据不是合法的 base64：{error}"))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))?;
    }
    let temp = path.with_extension("tmp-write");
    fs::write(&temp, bytes).map_err(|error| format!("写入失败 {name}：{error}"))?;
    fs::rename(&temp, &path).map_err(|error| format!("写入失败 {name}：{error}"))
}

/// 列出某个前缀下的全部文件（相对路径，正斜杠）。
#[tauri::command]
fn rw_list(app: tauri::AppHandle, prefix: String) -> Result<Vec<String>, String> {
    let root = data_root(&app)?;
    let start = if prefix.is_empty() {
        root.clone()
    } else {
        resolve(&root, &prefix)?
    };
    let mut found = Vec::new();
    if !start.exists() {
        return Ok(found);
    }
    let mut stack = vec![start];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).map_err(|error| format!("无法列出目录：{error}"))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(relative) = path.strip_prefix(&root) {
                found.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    found.sort();
    Ok(found)
}

#[tauri::command]
fn rw_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let root = data_root(&app)?;
    let path = resolve(&root, &name)?;
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|error| format!("删除失败 {name}：{error}"))
    } else {
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("删除失败 {name}：{error}")),
        }
    }
}

/// 清空某个目录（用于「清空本机数据」）。
#[tauri::command]
fn rw_clear(app: tauri::AppHandle, prefix: String) -> Result<(), String> {
    let root = data_root(&app)?;
    let path = if prefix.is_empty() {
        root.clone()
    } else {
        resolve(&root, &prefix)?
    };
    if !path.exists() {
        return Ok(());
    }
    fs::remove_dir_all(&path).map_err(|error| format!("清空失败：{error}"))?;
    fs::create_dir_all(&path).map_err(|error| format!("清空失败：{error}"))
}

/// 数据目录绝对路径，界面上显示给用户看（"我的数据在哪"）。
#[tauri::command]
fn rw_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(data_root(&app)?.to_string_lossy().to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            rw_read_text,
            rw_write_text,
            rw_read_binary,
            rw_write_binary,
            rw_list,
            rw_delete,
            rw_clear,
            rw_data_dir
        ])
        .run(tauri::generate_context!())
        .expect("启动角色世界失败");
}
