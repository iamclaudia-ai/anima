import SwiftUI
import Combine

/**
 * Claudia Menubar App
 *
 * A lightweight menubar app that provides:
 * - "Hey babe" wake word detection
 * - Voice input via speech recognition
 * - Text responses with TTS playback
 * - Native macOS bridge for the Anima gateway
 *
 * Icon: 💋 (when idle), 🎤 (when listening), 💬 (when speaking)
 */
@main
struct ClaudiaApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        MenuBarExtra {
            MenuBarView()
                .environmentObject(appState)
        } label: {
            Image(systemName: appState.statusIcon)
                .symbolRenderingMode(.hierarchical)
        }
        .menuBarExtraStyle(.window)
    }
}

/**
 * App-wide state management
 */
@MainActor
class AppState: ObservableObject {
    @Published var status: AppStatus = .idle
    @Published var isListening = false
    @Published var isSpeaking = false
    @Published var lastTranscript = ""
    @Published var lastResponse = ""
    @Published var isConnected = false
    @Published var error: String?

    let gateway = GatewayClient()
    let speechRecognizer = SpeechRecognizer()
    let audioPlayer = AudioPlayer()
    let nativeRegistry = NativeHandlerRegistry()

    var statusIcon: String {
        switch status {
        case .idle: return "mouth.fill"  // 💋 vibes
        case .listening: return "mic.fill"
        case .processing: return "ellipsis.circle.fill"
        case .speaking: return "speaker.wave.2.fill"
        case .error: return "exclamationmark.triangle.fill"
        }
    }

    init() {
        registerNativeHandlers()
        setupGateway()
        setupSpeechRecognizer()
    }

    // MARK: - Native Bridge

    private func registerNativeHandlers() {
        nativeRegistry.register(NotificationHandler.self)
        nativeRegistry.register(ClipboardHandler.self)
        nativeRegistry.register(AppleScriptHandler.self)
        nativeRegistry.register(OpenHandler.self)
        nativeRegistry.register(SystemInfoHandler.self)
        nativeRegistry.register(ShellHandler.self)
    }

    // MARK: - Gateway

    private func setupGateway() {
        gateway.onConnected = { [weak self] in
            Task { @MainActor in
                self?.isConnected = true
                self?.error = nil
                // Start wake word listening as soon as we're connected
                self?.startWakeWordListening()
            }
        }

        gateway.onDisconnected = { [weak self] in
            Task { @MainActor in
                self?.isConnected = false
            }
        }

        gateway.onResponse = { [weak self] text in
            Task { @MainActor in
                self?.lastResponse = text
            }
        }

        gateway.onResponseComplete = { [weak self] in
            Task { @MainActor in
                // If we're not speaking (no audio), restart wake word listening
                if self?.status == .processing {
                    self?.status = .idle
                    self?.startWakeWordListening()
                }
            }
        }

        gateway.onAudio = { [weak self] audioData in
            Task { @MainActor in
                self?.status = .speaking
                self?.isSpeaking = true
                self?.audioPlayer.play(audioData) {
                    Task { @MainActor in
                        self?.status = .idle
                        self?.isSpeaking = false
                        // Re-enable wake word listening after speaking
                        self?.startWakeWordListening()
                    }
                }
            }
        }

        gateway.onError = { [weak self] error in
            Task { @MainActor in
                self?.error = error
                self?.status = .error
                // Restart wake word listening even on error
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    Task { @MainActor in
                        self?.startWakeWordListening()
                    }
                }
            }
        }

        // Native bridge: dispatch incoming commands to handlers
        gateway.onNativeCommand = { [weak self] command, params, requestId in
            guard let self = self else { return }
            // Strip "native." prefix if present
            let cmd = command.hasPrefix("native.") ? String(command.dropFirst(7)) : command

            self.nativeRegistry.dispatch(command: cmd, params: params) { [weak self] result in
                switch result {
                case .success(let resultDict):
                    self?.gateway.sendNativeResult(requestId: requestId, ok: true, result: resultDict, error: nil)
                case .failure(let error):
                    self?.gateway.sendNativeResult(requestId: requestId, ok: false, result: nil, error: error.localizedDescription)
                }
            }
        }

        // Connect to gateway
        gateway.connect()
    }

    // MARK: - Speech

    private func setupSpeechRecognizer() {
        speechRecognizer.onWakeWord = { [weak self] in
            Task { @MainActor in
                self?.handleWakeWord()
            }
        }

        speechRecognizer.onTranscript = { [weak self] transcript, isFinal in
            Task { @MainActor in
                self?.lastTranscript = transcript
                if isFinal {
                    self?.handleFinalTranscript(transcript)
                }
            }
        }
    }

    func startWakeWordListening() {
        status = .idle
        speechRecognizer.startWakeWordDetection()
    }

    func stopListening() {
        speechRecognizer.stop()
        status = .idle
        isListening = false
    }

    private func handleWakeWord() {
        // Wake word detected! Start full speech recognition
        status = .listening
        isListening = true
        speechRecognizer.startFullRecognition()
    }

    private func handleFinalTranscript(_ transcript: String) {
        guard !transcript.isEmpty else {
            startWakeWordListening()
            return
        }

        status = .processing
        isListening = false

        // Send to gateway with voice response
        gateway.sendPrompt(transcript, withVoice: true)
    }

    func sendTextPrompt(_ text: String) {
        status = .processing
        gateway.sendPrompt(text, withVoice: true)
    }

    func interruptSpeaking() {
        audioPlayer.stop()
        status = .idle
        isSpeaking = false
    }
}

enum AppStatus {
    case idle
    case listening
    case processing
    case speaking
    case error
}
