use std::fs;
use std::path::PathBuf;
use tauri::Manager;

pub mod database {
    use rusqlite::Connection;
    use std::path::Path;

    pub fn init_local_sqlite(db_path: &Path) -> Result<Connection, String> {
        let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
            .map_err(|e| e.to_string())?;
        Ok(conn)
    }
}

#[tauri::command]
fn get_data_directory(app: tauri::AppHandle) -> Result<String, String> {
    let dir: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Ok(data_dir) = app.path().app_data_dir() {
                let _ = fs::create_dir_all(data_dir.join("backups"));
                let _ = fs::create_dir_all(data_dir.join("keys"));
                let _ = database::init_local_sqlite(&data_dir.join("bedcare-local.sqlite"));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_data_directory])
        .run(tauri::generate_context!())
        .expect("Lỗi khởi chạy ứng dụng desktop BEDCARE");
}
