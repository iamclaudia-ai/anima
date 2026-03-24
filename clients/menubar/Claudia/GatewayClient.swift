import Foundation

/**
 * WebSocket client for Anima Gateway
 *
 * Connects to ws://localhost:30086/ws and handles the JSON protocol:
 * - Sends: { type: "req", id, method, params }
 * - Receives: { type: "res", id, ok, payload/error }
 * - Receives: { type: "event", event, payload }
 *
 * Also acts as the native bridge endpoint — listens for native.exec events
 * from the gateway and dispatches them to NativeHandlerRegistry.
 */
class GatewayClient: NSObject {
    private var webSocket: URLSessionWebSocketTask?
    private var session: URLSession!
    private var isConnecting = false

    // Gateway URL - can be overridden for Tailscale access
    private let gatewayURL: URL

    // Callbacks — voice/chat
    var onConnected: (() -> Void)?
    var onDisconnected: (() -> Void)?
    var onResponse: ((String) -> Void)?
    var onResponseComplete: (() -> Void)?
    var onAudio: ((Data) -> Void)?
    var onError: ((String) -> Void)?

    // Callback — native bridge commands from gateway
    var onNativeCommand: ((_ command: String, _ params: [String: Any], _ requestId: String) -> Void)?

    // Pending requests
    private var pendingRequests: [String: (Result<Any, Error>) -> Void] = [:]
    private var sessionRecordId: String?
    private let model = "claude-sonnet-4-20250514"
    private let thinking = true
    private let effort = "medium"
    private let cwd = "/Users/michael/claudia/chat"

    // Response accumulator
    private var responseText = ""

    override init() {
        // Default to localhost, can be configured via environment or defaults
        let urlString = ProcessInfo.processInfo.environment["ANIMA_GATEWAY_URL"]
            ?? UserDefaults.standard.string(forKey: "gatewayURL")
            ?? "ws://localhost:30086/ws"
        self.gatewayURL = URL(string: urlString)!

        super.init()

        let config = URLSessionConfiguration.default
        self.session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    func connect() {
        guard webSocket == nil && !isConnecting else { return }
        isConnecting = true

        print("[Gateway] Connecting to \(gatewayURL)")
        webSocket = session.webSocketTask(with: gatewayURL)
        webSocket?.resume()
    }

    func disconnect() {
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        onDisconnected?()
    }

    // MARK: - Chat / Voice

    /**
     * Send a prompt to Claudia with optional voice response
     */
    func sendPrompt(_ content: String, withVoice: Bool = true) {
        responseText = ""

        guard let sessionRecordId else {
            onError?("No session initialized yet")
            return
        }
        var params: [String: Any] = [
            "content": content,
            "sessionId": sessionRecordId,
            "model": model,
            "thinking": thinking,
            "effort": effort,
        ]
        if withVoice {
            params["speakResponse"] = true
        }

        sendRequest(method: "session.send_prompt", params: params) { [weak self] result in
            if case .failure(let error) = result {
                self?.onError?(error.localizedDescription)
            }
        }
    }

    /**
     * Manually trigger TTS for text
     */
    func speak(_ text: String) {
        sendRequest(method: "voice.speak", params: ["text": text]) { [weak self] result in
            if case .failure(let error) = result {
                self?.onError?(error.localizedDescription)
            }
        }
    }

    // MARK: - Native Bridge

    /**
     * Send the result of a native command back to the gateway.
     * Called by NativeBridgeDispatcher after executing a handler.
     */
    func sendNativeResult(requestId: String, ok: Bool, result: [String: Any]?, error: String?) {
        var params: [String: Any] = [
            "requestId": requestId,
            "ok": ok,
        ]
        if let result = result {
            params["result"] = result
        }
        if let error = error {
            params["error"] = error
        }

        sendRequest(method: "native.result", params: params) { _ in }
    }

    // MARK: - WebSocket transport

    func sendRequest(method: String, params: [String: Any], completion: @escaping (Result<Any, Error>) -> Void) {
        let id = UUID().uuidString

        let message: [String: Any] = [
            "type": "req",
            "id": id,
            "method": method,
            "params": params,
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let jsonString = String(data: data, encoding: .utf8)
        else {
            completion(.failure(GatewayError.serializationFailed))
            return
        }

        pendingRequests[id] = completion

        webSocket?.send(.string(jsonString)) { [weak self] error in
            if let error = error {
                self?.pendingRequests.removeValue(forKey: id)
                completion(.failure(error))
            }
        }
    }

    private func receiveMessage() {
        webSocket?.receive { [weak self] result in
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self?.handleMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self?.handleMessage(text)
                    }
                @unknown default:
                    break
                }
                // Continue receiving
                self?.receiveMessage()

            case .failure(let error):
                print("[Gateway] Receive error: \(error)")
                self?.handleDisconnect()
            }
        }
    }

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String
        else {
            return
        }

        switch type {
        case "res":
            handleResponse(json)
        case "event":
            handleEvent(json)
        default:
            break
        }
    }

    private func handleResponse(_ json: [String: Any]) {
        guard let id = json["id"] as? String,
              let completion = pendingRequests.removeValue(forKey: id)
        else {
            return
        }

        if json["ok"] as? Bool == true {
            if let payload = json["payload"] as? [String: Any],
               let session = payload["session"] as? [String: Any],
               let sid = session["id"] as? String
            {
                sessionRecordId = sid
            } else if let payload = json["payload"] as? [String: Any],
                      let workspace = payload["workspace"] as? [String: Any],
                      let wsId = workspace["id"] as? String
            {
                if let active = workspace["activeSessionId"] as? String {
                    sessionRecordId = active
                } else {
                    sendRequest(method: "session.create_session", params: [
                        "workspaceId": wsId,
                        "model": model,
                        "thinking": thinking,
                        "effort": effort,
                    ]) { _ in }
                }
            }
            completion(.success(json["payload"] ?? [:]))
        } else {
            let error = json["error"] as? String ?? "Unknown error"
            completion(.failure(GatewayError.serverError(error)))
        }
    }

    private func handleEvent(_ json: [String: Any]) {
        guard let event = json["event"] as? String,
              let payload = json["payload"] as? [String: Any]
        else {
            return
        }

        switch event {
        case "session.content_block_delta":
            // Streaming text
            if let delta = payload["delta"] as? [String: Any],
               let text = delta["text"] as? String
            {
                responseText += text
                onResponse?(responseText)
            }

        case "session.message_stop":
            // Response complete
            print("[Gateway] Response complete")
            onResponseComplete?()

        case "voice.audio":
            // Audio data received
            if let audioBase64 = payload["data"] as? String,
               let audioData = Data(base64Encoded: audioBase64)
            {
                onAudio?(audioData)
            }

        case "voice.speaking":
            print("[Gateway] Voice: speaking...")

        case "voice.done":
            print("[Gateway] Voice: done")

        case "voice.error":
            if let error = payload["error"] as? String {
                onError?("Voice error: \(error)")
            }

        case "native.exec":
            // Native bridge command from gateway
            if let command = payload["command"] as? String,
               let requestId = payload["requestId"] as? String
            {
                let params = payload["params"] as? [String: Any] ?? [:]
                print("[Gateway] Native command: \(command) (req: \(requestId))")
                onNativeCommand?(command, params, requestId)
            }

        default:
            break
        }
    }

    private func handleDisconnect() {
        webSocket = nil
        isConnecting = false
        onDisconnected?()

        // Auto-reconnect after delay
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            self?.connect()
        }
    }
}

extension GatewayClient: URLSessionWebSocketDelegate {
    func urlSession(_: URLSession, webSocketTask _: URLSessionWebSocketTask, didOpenWithProtocol _: String?) {
        print("[Gateway] Connected!")
        isConnecting = false

        // Subscribe to session, voice, AND native events
        sendRequest(method: "gateway.subscribe", params: ["events": ["session.*", "voice.*", "native.*"]]) { _ in }

        // Get or create workspace
        sendRequest(method: "session.get_or_create_workspace", params: ["cwd": cwd, "name": "Voice Mode"]) { _ in }

        onConnected?()
        receiveMessage()
    }

    func urlSession(_: URLSession, webSocketTask _: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason _: Data?) {
        print("[Gateway] Disconnected: \(closeCode)")
        handleDisconnect()
    }
}

enum GatewayError: LocalizedError {
    case serializationFailed
    case serverError(String)

    var errorDescription: String? {
        switch self {
        case .serializationFailed:
            return "Failed to serialize request"
        case .serverError(let message):
            return message
        }
    }
}
