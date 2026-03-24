import Foundation

/**
 * Execute arbitrary AppleScript via NSAppleScript.
 *
 * This is the "escape hatch" — any macOS automation that doesn't have
 * a dedicated handler can be done via AppleScript without rebuilding the app.
 *
 * Note: Requires Automation permission per target app (granted on first use).
 * The app sandbox must be disabled for this to work.
 *
 * Params:
 *   - script: String (required) — the AppleScript source code
 */
struct AppleScriptHandler: NativeHandler {
    static let command = "applescript"
    static let description = "Execute AppleScript for macOS automation"

    static func handle(
        params: [String: Any],
        completion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
        guard let source = params["script"] as? String else {
            completion(.failure(NativeBridgeError.missingParam("script")))
            return
        }

        // Run on a background queue to avoid blocking the main thread
        DispatchQueue.global(qos: .userInitiated).async {
            guard let script = NSAppleScript(source: source) else {
                completion(.failure(NativeBridgeError.executionFailed("Failed to create AppleScript")))
                return
            }

            var errorInfo: NSDictionary?
            let result = script.executeAndReturnError(&errorInfo)

            if let errorInfo = errorInfo {
                let message = errorInfo[NSAppleScript.errorMessage] as? String ?? "Unknown AppleScript error"
                let errorNumber = errorInfo[NSAppleScript.errorNumber] as? Int ?? -1
                print("[NativeBridge] AppleScript error (\(errorNumber)): \(message)")
                completion(.failure(NativeBridgeError.executionFailed(message)))
            } else {
                let output = result.stringValue ?? ""
                print("[NativeBridge] AppleScript executed, result: \(output.prefix(100))")
                completion(.success(["result": output]))
            }
        }
    }
}
