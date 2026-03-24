import Foundation

/**
 * Protocol for native macOS command handlers.
 *
 * Each handler registers a command name and handles requests from the gateway.
 * Adding a new capability = one new file conforming to this protocol + one line in the registry.
 */
protocol NativeHandler {
    /// The command name, e.g. "notify", "clipboard.read", "screenshot"
    static var command: String { get }

    /// Human-readable description for discovery
    static var description: String { get }

    /// Handle a command invocation.
    /// Params come from the gateway event payload.
    /// Call completion with the result (dictionary) or an error.
    static func handle(
        params: [String: Any],
        completion: @escaping (Result<[String: Any], Error>) -> Void
    )
}

/**
 * Registry that maps command names to handlers and dispatches incoming requests.
 */
class NativeHandlerRegistry {
    private var handlers: [String: NativeHandler.Type] = [:]

    /// Register a handler type. Called once at app startup.
    func register(_ handler: NativeHandler.Type) {
        handlers[handler.command] = handler
        print("[NativeBridge] Registered handler: native.\(handler.command)")
    }

    /// Dispatch a command to its registered handler.
    func dispatch(
        command: String,
        params: [String: Any],
        completion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
        guard let handler = handlers[command] else {
            completion(.failure(NativeBridgeError.unknownCommand(command)))
            return
        }

        print("[NativeBridge] Dispatching: native.\(command)")
        handler.handle(params: params, completion: completion)
    }

    /// List all registered commands (for discovery).
    func listCommands() -> [[String: String]] {
        return handlers.map { (command, handler) in
            ["command": "native.\(command)", "description": handler.description]
        }
    }
}

enum NativeBridgeError: LocalizedError {
    case unknownCommand(String)
    case missingParam(String)
    case executionFailed(String)

    var errorDescription: String? {
        switch self {
        case .unknownCommand(let cmd):
            return "Unknown native command: \(cmd)"
        case .missingParam(let param):
            return "Missing required parameter: \(param)"
        case .executionFailed(let reason):
            return "Execution failed: \(reason)"
        }
    }
}
