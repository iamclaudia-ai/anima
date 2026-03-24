import Foundation
import AppKit

/**
 * Open URLs, files, and applications via NSWorkspace.
 *
 * No permissions required. Works with any URL scheme (https://, file://, etc.)
 * and can launch apps by bundle identifier.
 *
 * Params:
 *   - url: String? — URL to open (https://..., file://..., etc.)
 *   - app: String? — bundle identifier to launch (e.g. "com.apple.Safari")
 *   - path: String? — file path to open with default app
 *
 * At least one of url, app, or path must be provided.
 */
struct OpenHandler: NativeHandler {
    static let command = "open"
    static let description = "Open URLs, files, or launch applications"

    static func handle(
        params: [String: Any],
        completion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
        let workspace = NSWorkspace.shared

        if let urlString = params["url"] as? String, let url = URL(string: urlString) {
            let success = workspace.open(url)
            print("[NativeBridge] Open URL: \(urlString) → \(success)")
            completion(.success(["opened": success, "type": "url"]))
            return
        }

        if let bundleId = params["app"] as? String {
            if let appURL = workspace.urlForApplication(withBundleIdentifier: bundleId) {
                let config = NSWorkspace.OpenConfiguration()
                workspace.openApplication(at: appURL, configuration: config) { app, error in
                    if let error = error {
                        completion(.failure(NativeBridgeError.executionFailed(error.localizedDescription)))
                    } else {
                        let name = app?.localizedName ?? bundleId
                        print("[NativeBridge] Launched app: \(name)")
                        completion(.success(["opened": true, "type": "app", "name": name]))
                    }
                }
            } else {
                completion(.failure(NativeBridgeError.executionFailed("App not found: \(bundleId)")))
            }
            return
        }

        if let path = params["path"] as? String {
            let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
            let success = workspace.open(url)
            print("[NativeBridge] Open file: \(path) → \(success)")
            completion(.success(["opened": success, "type": "file"]))
            return
        }

        completion(.failure(NativeBridgeError.missingParam("url, app, or path")))
    }
}
