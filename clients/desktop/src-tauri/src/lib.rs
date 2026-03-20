use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, PhysicalPosition, PhysicalSize, WebviewWindow, Window,
};

// ============================================================================
// Window State Persistence
// ============================================================================

/// Position and size for a specific display configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
struct DisplayState {
    /// Number of monitors in this configuration
    monitor_count: usize,
    /// Window position
    x: i32,
    y: i32,
    /// Window size
    width: u32,
    height: u32,
    /// Which monitor the window was on (index)
    monitor_index: usize,
}

/// Persisted window state across launches
#[derive(Debug, Clone, Serialize, Deserialize)]
struct WindowState {
    /// Per-display-config positions (keyed by monitor count as string)
    displays: std::collections::HashMap<String, DisplayState>,
    /// Last active monitor count
    last_monitor_count: usize,
    /// Whether always-on-top was enabled
    always_on_top: bool,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            displays: std::collections::HashMap::new(),
            last_monitor_count: 0,
            always_on_top: true, // Default to always-on-top enabled
        }
    }
}

fn state_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".anima").join("desktop-window-state.json")
}

fn load_window_state() -> WindowState {
    let path = state_path();
    if let Ok(data) = fs::read_to_string(&path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        WindowState::default()
    }
}

fn save_window_state(state: &WindowState) {
    let path = state_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(state) {
        let _ = fs::write(&path, json);
    }
}

/// Capture current window state (uses Window from on_window_event)
fn capture_state(window: &Window) -> Option<DisplayState> {
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    let monitors = window.available_monitors().ok()?;
    let monitor_count = monitors.len().max(1);

    // Determine which monitor the window center falls on
    let center_x = pos.x + (size.width as i32 / 2);
    let center_y = pos.y + (size.height as i32 / 2);
    let mut monitor_index = 0;
    for (i, monitor) in monitors.iter().enumerate() {
        let mpos = monitor.position();
        let msize = monitor.size();
        if center_x >= mpos.x
            && center_x < mpos.x + msize.width as i32
            && center_y >= mpos.y
            && center_y < mpos.y + msize.height as i32
        {
            monitor_index = i;
            break;
        }
    }

    Some(DisplayState {
        monitor_count,
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        monitor_index,
    })
}

/// Get the number of available monitors
fn get_monitor_count(window: &WebviewWindow) -> usize {
    window
        .available_monitors()
        .map(|m| m.len().max(1))
        .unwrap_or(1)
}

/// Restore window to saved position for current display configuration
fn restore_position(window: &WebviewWindow, state: &WindowState) {
    let monitor_count = get_monitor_count(window);
    let key = monitor_count.to_string();

    if let Some(display_state) = state.displays.get(&key) {
        // Verify the saved position is still valid (monitor might have been removed)
        let position_valid = if let Ok(monitors) = window.available_monitors() {
            let target_idx = display_state.monitor_index.min(monitors.len().saturating_sub(1));
            if let Some(monitor) = monitors.get(target_idx) {
                let mpos = monitor.position();
                let msize = monitor.size();
                display_state.x >= mpos.x - display_state.width as i32
                    && display_state.x < mpos.x + msize.width as i32
                    && display_state.y >= mpos.y - display_state.height as i32
                    && display_state.y < mpos.y + msize.height as i32
            } else {
                false
            }
        } else {
            false
        };

        if position_valid {
            let _ = window.set_position(PhysicalPosition::new(display_state.x, display_state.y));
            let _ = window.set_size(PhysicalSize::new(display_state.width, display_state.height));
        }
    }
}

// ============================================================================
// Commands
// ============================================================================

/// Toggle always-on-top for the main window (callable from JS via invoke)
#[tauri::command]
fn toggle_always_on_top(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<WindowState>>>,
) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;

    let current = window.is_always_on_top().map_err(|e| e.to_string())?;
    let new_state = !current;
    window
        .set_always_on_top(new_state)
        .map_err(|e| e.to_string())?;

    // Update state
    let mut ws = state.lock().unwrap();
    ws.always_on_top = new_state;
    save_window_state(&ws);

    Ok(new_state)
}

// ============================================================================
// App Entry
// ============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load saved window state
    let saved_state = load_window_state();
    let always_on_top = saved_state.always_on_top;

    // Window state (shared between managed state and event handler)
    let window_state: Arc<Mutex<WindowState>> = Arc::new(Mutex::new(saved_state.clone()));
    let window_state_for_events = window_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(window_state)
        .invoke_handler(tauri::generate_handler![toggle_always_on_top])
        .setup(move |app| {
            // Restore window position from saved state
            if let Some(window) = app.get_webview_window("main") {
                restore_position(&window, &saved_state);

                // Restore always-on-top preference
                if always_on_top {
                    let _ = window.set_always_on_top(true);
                }
            }

            // Build menu bar with Edit and Window menus

            // Edit menu with standard shortcuts
            let cut = PredefinedMenuItem::cut(app, None)?;
            let copy = PredefinedMenuItem::copy(app, None)?;
            let paste = PredefinedMenuItem::paste(app, None)?;
            let select_all = PredefinedMenuItem::select_all(app, None)?;
            let undo = PredefinedMenuItem::undo(app, None)?;
            let redo = PredefinedMenuItem::redo(app, None)?;

            let edit_menu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[&undo, &redo, &cut, &copy, &paste, &select_all],
            )?;

            // Window menu
            let on_top_label = if always_on_top {
                "Always on Top ✓"
            } else {
                "Always on Top"
            };
            let on_top_menubar =
                MenuItem::with_id(app, "menubar_on_top", on_top_label, true, None::<&str>)?;
            let minimize = PredefinedMenuItem::minimize(app, None)?;
            let zoom = PredefinedMenuItem::maximize(app, None)?;
            let close = PredefinedMenuItem::close_window(app, None)?;

            let window_menu = Submenu::with_items(
                app,
                "Window",
                true,
                &[&on_top_menubar, &minimize, &zoom, &close],
            )?;

            let menu_bar = Menu::with_items(app, &[&edit_menu, &window_menu])?;
            app.set_menu(menu_bar)?;

            // Handle menubar events
            app.on_menu_event(move |app, event| {
                if event.id == "menubar_on_top" {
                    if let Some(window) = app.get_webview_window("main") {
                        if let Ok(current) = window.is_always_on_top() {
                            let new_state = !current;
                            let _ = window.set_always_on_top(new_state);

                            // Update persisted state
                            let state: tauri::State<Arc<Mutex<WindowState>>> = app.state();
                            let mut ws = state.lock().unwrap();
                            ws.always_on_top = new_state;
                            save_window_state(&ws);
                        }
                    }
                }
            });

            // Build tray menu
            let show = MenuItem::with_id(app, "tray_show", "Show Anima", true, None::<&str>)?;
            let on_top_tray =
                MenuItem::with_id(app, "tray_on_top", on_top_label, true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "tray_quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show, &on_top_tray, &quit])?;

            // Create tray icon
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Anima")
                .menu(&tray_menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "tray_show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "tray_on_top" => {
                        if let Some(window) = app.get_webview_window("main") {
                            if let Ok(current) = window.is_always_on_top() {
                                let new_state = !current;
                                let _ = window.set_always_on_top(new_state);

                                // Update persisted state
                                let state: tauri::State<Arc<Mutex<WindowState>>> = app.state();
                                let mut ws = state.lock().unwrap();
                                ws.always_on_top = new_state;
                                save_window_state(&ws);
                            }
                        }
                    }
                    "tray_quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Click tray icon → show + focus window
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        // Save window state on close
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(ds) = capture_state(window) {
                    let mut state = window_state_for_events.lock().unwrap();
                    let key = ds.monitor_count.to_string();
                    state.last_monitor_count = ds.monitor_count;
                    state.displays.insert(key, ds);
                    save_window_state(&state);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Anima desktop");
}
