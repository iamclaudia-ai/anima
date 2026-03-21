import XCTest
@testable import VoiceModeGateway

final class GatewayWireProtocolTests: XCTestCase {
    func testMakeRequestIncludesCoreFields() throws {
        let json = GatewayWireProtocol.makeRequest(
            id: "req-1",
            method: "session.send_prompt",
            params: ["sessionId": "ses_1", "content": "hello"],
            tags: ["voice.speak"]
        )
        XCTAssertNotNil(json)

        let data = try XCTUnwrap(json?.data(using: .utf8))
        let dict = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(dict["type"] as? String, "req")
        XCTAssertEqual(dict["id"] as? String, "req-1")
        XCTAssertEqual(dict["method"] as? String, "session.send_prompt")
        XCTAssertEqual((dict["tags"] as? [String]) ?? [], ["voice.speak"])
        let params = try XCTUnwrap(dict["params"] as? [String: Any])
        XCTAssertEqual(params["sessionId"] as? String, "ses_1")
        XCTAssertEqual(params["content"] as? String, "hello")
    }

    func testMakePong() throws {
        let json = GatewayWireProtocol.makePong(id: "ping-1")
        XCTAssertNotNil(json)

        let data = try XCTUnwrap(json?.data(using: .utf8))
        let dict = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(dict["type"] as? String, "pong")
        XCTAssertEqual(dict["id"] as? String, "ping-1")
    }

    func testParsePing() {
        let parsed = GatewayWireProtocol.parse(#"{"type":"ping","id":"ping-123","timestamp":1}"#)
        guard case .ping(let id)? = parsed else {
            return XCTFail("Expected ping")
        }
        XCTAssertEqual(id, "ping-123")
    }

    func testParseResponse() {
        let parsed = GatewayWireProtocol.parse(
            #"{"type":"res","id":"r1","ok":true,"payload":{"sessionId":"ses_1"}}"#
        )
        guard case .response(let id, let ok, let payload, let error)? = parsed else {
            return XCTFail("Expected response")
        }
        XCTAssertEqual(id, "r1")
        XCTAssertTrue(ok)
        XCTAssertNil(error)
        let dict = payload as? [String: Any]
        XCTAssertEqual(dict?["sessionId"] as? String, "ses_1")
    }

    func testParseEvent() {
        let parsed = GatewayWireProtocol.parse(
            #"{"type":"event","event":"voice.stream_end","payload":{"streamId":"s1"}}"#
        )
        guard case .event(let name, let payload)? = parsed else {
            return XCTFail("Expected event")
        }
        XCTAssertEqual(name, "voice.stream_end")
        XCTAssertEqual(payload["streamId"] as? String, "s1")
    }

    func testParseInvalidReturnsNil() {
        XCTAssertNil(GatewayWireProtocol.parse("{not-json"))
        XCTAssertNil(GatewayWireProtocol.parse(#"{"type":"res"}"#))
    }

    func testBuildGatewayURLAlwaysUsesWSSAndWSPath() {
        XCTAssertEqual(
            GatewayWireProtocol.buildGatewayURL(host: "gateway.anima-sedes.com"),
            "wss://gateway.anima-sedes.com/ws"
        )
        XCTAssertEqual(
            GatewayWireProtocol.buildGatewayURL(host: "https://gateway.anima-sedes.com/custom"),
            "wss://gateway.anima-sedes.com/ws"
        )
        XCTAssertEqual(
            GatewayWireProtocol.buildGatewayURL(host: "gateway.anima-sedes.com:3443/ws"),
            "wss://gateway.anima-sedes.com:3443/ws"
        )
    }

    func testLoadGatewayHostFallsBackToLegacyGatewayURL() {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        defaults.set("wss://legacy.anima.example/ws", forKey: "gatewayURL")

        XCTAssertEqual(
            GatewayWireProtocol.loadGatewayHost(defaults: defaults),
            "legacy.anima.example"
        )
    }
}
