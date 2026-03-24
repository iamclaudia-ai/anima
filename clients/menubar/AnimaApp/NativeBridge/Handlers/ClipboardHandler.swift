import Foundation
import AppKit

/**
 * Native macOS clipboard handler.
 *
 * Read and write to the system pasteboard. No permissions required.
 *
 * Commands:
 *   - clipboard.read: Read current clipboard text
 *   - clipboard.write: Write text to clipboard
 *
 * Note: This registers as "clipboard" and handles sub-commands via the "action" param.
 *
 * Params:
 *   - action: "read" | "write" (required)
 *   - text: String (required for write)
 */
struct ClipboardHandler: NativeHandler {
    static let command = "clipboard"
    static let description = "Read from or write to the system clipboard"

    static func handle(
        params: [String: Any],
        completion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
        let action = params["action"] as? String ?? "read"
        let pasteboard = NSPasteboard.general

        switch action {
        case "read":
            let text = pasteboard.string(forType: .string) ?? ""
            let hasImage = pasteboard.data(forType: .png) != nil
                || pasteboard.data(forType: .tiff) != nil
            completion(.success([
                "text": text,
                "hasImage": hasImage,
                "types": pasteboard.types?.map(\.rawValue) ?? [],
            ]))

        case "write":
            guard let text = params["text"] as? String else {
                completion(.failure(NativeBridgeError.missingParam("text")))
                return
            }
            pasteboard.clearContents()
            pasteboard.setString(text, forType: .string)
            print("[NativeBridge] Clipboard: wrote \(text.count) chars")
            completion(.success(["written": true, "length": text.count]))

        default:
            completion(.failure(NativeBridgeError.executionFailed("Unknown clipboard action: \(action). Use 'read' or 'write'.")))
        }
    }
}
