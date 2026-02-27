import Foundation

/// WebSocket client for Claudia Gateway
///
/// Connects to the gateway and handles the streaming voice protocol:
/// - Sends: { type: "req", id, method, params }
/// - Receives: { type: "res", id, ok, payload/error }
/// - Receives: { type: "event", event, payload }
class GatewayClient: NSObject, @unchecked Sendable {
    private let model = "claude-opus-4-6"
    private let thinking = true
    private let effort = "medium"
    private var webSocket: URLSessionWebSocketTask?
    private var session: URLSession!
    private var isConnecting = false
    private var shouldReconnect = true

    private let gatewayURL: URL
    private var pendingRequests: [String: (Result<Any, Error>) -> Void] = [:]
    private var connectionId: String?

    // Working directory for voice mode sessions
    private let cwd: String
    private var activeSessionId: String?

    // Callbacks — set by AppState
    var onConnected: (() -> Void)?
    var onDisconnected: (() -> Void)?
    var onStreamStart: ((_ streamId: String) -> Void)?
    var onAudioChunk: ((_ audio: Data, _ index: Int, _ streamId: String) -> Void)?
    var onStreamEnd: ((_ streamId: String) -> Void)?
    var onError: ((String) -> Void)?
    var onSessionResolved: ((_ message: String) -> Void)?

    init(url: String, cwd: String = "/Users/michael/claudia/chat") {
        self.gatewayURL = URL(string: url)!
        // Use server path directly (no expansion needed)
        self.cwd = cwd
        super.init()
        let config = URLSessionConfiguration.default
        self.session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    func connect() {
        guard webSocket == nil && !isConnecting else { return }
        isConnecting = true
        shouldReconnect = true
        print("[Gateway] Connecting to \(gatewayURL)")
        webSocket = session.webSocketTask(with: gatewayURL)
        webSocket?.resume()
    }

    func disconnect() {
        shouldReconnect = false
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        DispatchQueue.main.async { self.onDisconnected?() }
    }

    var isConnected: Bool {
        webSocket != nil && !isConnecting
    }

    // MARK: - Public API

    /// Initialize workspace, session, and subscriptions — called after WebSocket connects
    func initializeSession() {
        print("[Gateway] Initializing voice mode session (cwd: \(cwd))")

        // 1) Ensure workspace exists for voice mode cwd
        sendRequest(method: "session.get_or_create_workspace", params: ["cwd": cwd, "name": "Voice Mode"]) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let payload):
                guard let dict = payload as? [String: Any],
                      let workspace = dict["workspace"] as? [String: Any] else {
                    print("[Gateway] Unexpected workspace response")
                    DispatchQueue.main.async { self.onError?("Invalid workspace response") }
                    return
                }

                let workspaceId = workspace["id"] as? String ?? "unknown"
                print("[Gateway] Workspace ready: \(workspaceId)")

                func subscribeForSession(sessionId: String, action: String) {
                    self.activeSessionId = sessionId
                    let streamEvents = ["session.*", "voice.*", "session.\(sessionId).*"]
                    let resolvedMessage = "[\(action)] sessionId=\(sessionId)"

                    self.sendRequest(method: "gateway.subscribe", params: ["events": streamEvents]) { subscribeResult in
                        switch subscribeResult {
                        case .success:
                            print("[Gateway] Subscribed to events")
                            DispatchQueue.main.async { self.onSessionResolved?(resolvedMessage) }
                            DispatchQueue.main.async { self.onConnected?() }
                        case .failure(let subscribeError):
                            print("[Gateway] Subscribe failed: \(subscribeError)")
                            DispatchQueue.main.async {
                                self.onError?("Subscribe failed: \(subscribeError.localizedDescription)")
                            }
                        }
                    }
                }

                func createSession() {
                    self.sendRequest(method: "session.create_session", params: [
                        "cwd": self.cwd,
                        "model": self.model,
                        "thinking": self.thinking,
                        "effort": self.effort
                    ]) { createResult in
                        switch createResult {
                        case .success(let createPayload):
                            guard let created = createPayload as? [String: Any],
                                  let createdSessionId = created["sessionId"] as? String else {
                                DispatchQueue.main.async {
                                    self.onError?("Session create succeeded but returned no sessionId")
                                }
                                return
                            }
                            print("[Gateway] Session created: \(createdSessionId)")
                            subscribeForSession(sessionId: createdSessionId, action: "Created session")
                        case .failure(let createError):
                            print("[Gateway] Session create failed: \(createError)")
                            DispatchQueue.main.async {
                                self.onError?("Session create failed: \(createError.localizedDescription)")
                            }
                        }
                    }
                }

                // 2) Reuse most recent session for cwd, else create one
                self.sendRequest(method: "session.list_sessions", params: ["cwd": self.cwd]) { listResult in
                    switch listResult {
                    case .success(let listPayload):
                        guard let listDict = listPayload as? [String: Any],
                              let sessions = listDict["sessions"] as? [[String: Any]],
                              let mostRecent = sessions.first,
                              let targetSessionId = mostRecent["sessionId"] as? String else {
                            createSession()
                            return
                        }

                        print("[Gateway] Reusing session: \(targetSessionId)")
                        self.sendRequest(method: "session.switch_session", params: [
                            "sessionId": targetSessionId,
                            "cwd": self.cwd
                        ]) { switchResult in
                            switch switchResult {
                            case .success(let switchPayload):
                                if let switchDict = switchPayload as? [String: Any],
                                   let switchedSessionId = switchDict["sessionId"] as? String {
                                    print("[Gateway] Switched session: \(switchedSessionId)")
                                    subscribeForSession(sessionId: switchedSessionId, action: "Switched session")
                                } else {
                                    subscribeForSession(sessionId: targetSessionId, action: "Switched session")
                                }
                            case .failure(let switchError):
                                print("[Gateway] Session switch failed (\(switchError)) - creating new session")
                                createSession()
                            }
                        }
                    case .failure(let listError):
                        print("[Gateway] Session list failed (\(listError)) - creating new session")
                        createSession()
                    }
                }
            case .failure(let error):
                print("[Gateway] Workspace create failed: \(error)")
                DispatchQueue.main.async { self.onError?("Workspace failed: \(error.localizedDescription)") }
            }
        }
    }

    func sendPrompt(_ content: String) {
        var params: [String: Any] = [
            "content": content,
            "cwd": cwd
        ]
        if let sessionId = activeSessionId {
            params["sessionId"] = sessionId
        } else {
            onError?("Missing sessionId for prompt")
            return
        }
        sendRequest(method: "session.send_prompt", params: params, tags: ["voice.speak"]) { [weak self] result in
            if case .failure(let error) = result {
                self?.onError?(error.localizedDescription)
            }
        }
    }

    func sendInterrupt() {
        guard let sessionId = activeSessionId else { return }
        sendRequest(method: "session.interrupt_session", params: ["sessionId": sessionId]) { _ in }
    }

    func sendVoiceStop() {
        sendRequest(method: "voice.stop", params: [:]) { _ in }
    }

    // MARK: - Private

    private func sendRequest(
        method: String,
        params: [String: Any],
        tags: [String]? = nil,
        completion: @escaping (Result<Any, Error>) -> Void
    ) {
        let id = UUID().uuidString
        var message: [String: Any] = [
            "type": "req",
            "id": id,
            "method": method,
            "params": params
        ]
        if let tags, !tags.isEmpty {
            message["tags"] = tags
        }

        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let jsonString = String(data: data, encoding: .utf8) else {
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
              let type = json["type"] as? String else {
            return
        }

        switch type {
        case "ping":
            handlePing(json)
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
              let completion = pendingRequests.removeValue(forKey: id) else {
            return
        }

        if json["ok"] as? Bool == true {
            completion(.success(json["payload"] ?? [:]))
        } else {
            let error = json["error"] as? String ?? "Unknown error"
            completion(.failure(GatewayError.serverError(error)))
        }
    }

    private func handleEvent(_ json: [String: Any]) {
        guard let event = json["event"] as? String,
              let payload = json["payload"] as? [String: Any] else {
            return
        }

        switch event {
        case "gateway.welcome":
            if let id = payload["connectionId"] as? String {
                connectionId = id
                print("[Gateway] Connected with connectionId: \(id)")
            }

        case "voice.stream_start":
            let streamId = payload["streamId"] as? String ?? ""
            print("[Gateway] voice.stream_start: \(streamId)")
            DispatchQueue.main.async { self.onStreamStart?(streamId) }

        case "voice.audio_chunk":
            if let audioBase64 = payload["audio"] as? String,
               let audioData = Data(base64Encoded: audioBase64) {
                let index = payload["index"] as? Int ?? 0
                let streamId = payload["streamId"] as? String ?? ""
                print("[Gateway] voice.audio_chunk #\(index) (\(audioData.count) bytes)")
                DispatchQueue.main.async { self.onAudioChunk?(audioData, index, streamId) }
            }

        case "voice.stream_end":
            let streamId = payload["streamId"] as? String ?? ""
            print("[Gateway] voice.stream_end: \(streamId)")
            DispatchQueue.main.async { self.onStreamEnd?(streamId) }

        case "voice.error":
            if let error = payload["error"] as? String {
                DispatchQueue.main.async { self.onError?("Voice error: \(error)") }
            }

        default:
            break
        }
    }

    private func handlePing(_ json: [String: Any]) {
        guard let pingId = json["id"] as? String else { return }
        let pong: [String: Any] = ["type": "pong", "id": pingId]
        guard let data = try? JSONSerialization.data(withJSONObject: pong),
              let text = String(data: data, encoding: .utf8) else {
            return
        }
        webSocket?.send(.string(text)) { error in
            if let error {
                print("[Gateway] Failed to send pong: \(error)")
            }
        }
    }

    private func handleDisconnect() {
        webSocket = nil
        connectionId = nil
        isConnecting = false
        DispatchQueue.main.async { self.onDisconnected?() }

        guard shouldReconnect else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            self?.connect()
        }
    }
}

extension GatewayClient: URLSessionWebSocketDelegate {
    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        print("[Gateway] WebSocket connected — initializing session...")
        isConnecting = false
        receiveMessage()
        // Set up workspace + session + subscriptions, then signal onConnected
        initializeSession()
    }

    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
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
