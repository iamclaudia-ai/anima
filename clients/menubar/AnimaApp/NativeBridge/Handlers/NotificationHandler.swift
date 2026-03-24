import Foundation
import UserNotifications

/**
 * Native macOS notification handler.
 *
 * Shows local notifications via UNUserNotificationCenter.
 * Requests permission on first use.
 *
 * Params:
 *   - title: String (required) — notification title
 *   - body: String (required) — notification body text
 *   - subtitle: String? — optional subtitle
 *   - sound: Bool? — play notification sound (default: true)
 */
struct NotificationHandler: NativeHandler {
    static let command = "notify"
    static let description = "Show a native macOS notification"

    private static var permissionRequested = false

    static func handle(
        params: [String: Any],
        completion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
        guard let title = params["title"] as? String else {
            completion(.failure(NativeBridgeError.missingParam("title")))
            return
        }
        guard let body = params["body"] as? String else {
            completion(.failure(NativeBridgeError.missingParam("body")))
            return
        }

        let subtitle = params["subtitle"] as? String
        let playSound = params["sound"] as? Bool ?? true

        let center = UNUserNotificationCenter.current()

        // Ensure we have permission, then deliver
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error = error {
                completion(.failure(NativeBridgeError.executionFailed(error.localizedDescription)))
                return
            }

            guard granted else {
                completion(.failure(NativeBridgeError.executionFailed("Notification permission denied")))
                return
            }

            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            if let subtitle = subtitle {
                content.subtitle = subtitle
            }
            if playSound {
                content.sound = .default
            }

            let request = UNNotificationRequest(
                identifier: UUID().uuidString,
                content: content,
                trigger: nil  // Deliver immediately
            )

            center.add(request) { error in
                if let error = error {
                    completion(.failure(NativeBridgeError.executionFailed(error.localizedDescription)))
                } else {
                    print("[NativeBridge] Notification delivered: \(title)")
                    completion(.success(["delivered": true]))
                }
            }
        }
    }
}
