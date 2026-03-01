import Foundation

enum GatewayInboundMessage {
    case ping(id: String)
    case response(id: String, ok: Bool, payload: Any?, error: String?)
    case event(name: String, payload: [String: Any])
}

enum GatewayWireProtocol {
    static func makeRequest(
        id: String,
        method: String,
        params: [String: Any],
        tags: [String]? = nil
    ) -> String? {
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
              let jsonString = String(data: data, encoding: .utf8)
        else {
            return nil
        }
        return jsonString
    }

    static func makePong(id: String) -> String? {
        let pong: [String: Any] = ["type": "pong", "id": id]
        guard let data = try? JSONSerialization.data(withJSONObject: pong),
              let text = String(data: data, encoding: .utf8)
        else {
            return nil
        }
        return text
    }

    static func parse(_ text: String) -> GatewayInboundMessage? {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String
        else {
            return nil
        }

        switch type {
        case "ping":
            guard let id = json["id"] as? String else { return nil }
            return .ping(id: id)
        case "res":
            guard let id = json["id"] as? String,
                  let ok = json["ok"] as? Bool
            else { return nil }
            return .response(
                id: id,
                ok: ok,
                payload: json["payload"],
                error: json["error"] as? String
            )
        case "event":
            guard let event = json["event"] as? String,
                  let payload = json["payload"] as? [String: Any]
            else { return nil }
            return .event(name: event, payload: payload)
        default:
            return nil
        }
    }
}
