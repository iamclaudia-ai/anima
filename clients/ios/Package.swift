// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "VoiceModeGateway",
    platforms: [
        .iOS(.v17),
        .macOS(.v13)
    ],
    products: [
        .library(name: "VoiceModeGateway", targets: ["VoiceModeGateway"])
    ],
    targets: [
        .target(
            name: "VoiceModeGateway",
            path: "VoiceMode",
            exclude: [
                "Assets.xcassets",
                "AudioSessionManager.swift",
                "BrowserManager.swift",
                "BrowserView.swift",
                "GatewayClient.swift",
                "SpeechRecognizer.swift",
                "StreamingAudioPlayer.swift",
                "VoiceModeApp.swift",
                "VoiceModeView.swift"
            ],
            sources: ["GatewayWireProtocol.swift"]
        ),
        .testTarget(
            name: "VoiceModeGatewayTests",
            dependencies: ["VoiceModeGateway"],
            path: "Tests/VoiceModeGatewayTests"
        )
    ]
)
