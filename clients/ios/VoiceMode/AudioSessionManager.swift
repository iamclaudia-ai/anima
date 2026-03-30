import Foundation
import AVFoundation
import Combine

struct AudioRouteDescriptor: Identifiable, Equatable {
    let id: String
    let name: String
    let detail: String
}

/// Shared audio engine manager that keeps a single AVAudioEngine running
/// across all voice states (listening, processing, speaking).
///
/// Key insight: Input taps and player node scheduling can be added/removed
/// without stopping the engine. The engine stays alive so iOS never sees
/// a gap in audio activity and won't suspend the app.
class AudioSessionManager: ObservableObject {
    let engine = AVAudioEngine()
    let playerNode = AVAudioPlayerNode()
    let playerFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 24000,
        channels: 1,
        interleaved: false
    )!

    /// Whether the mic input tap is currently installed
    private var micTapInstalled = false

    /// Callback for audio interruptions (phone calls, Siri, etc.)
    var onInterruptionBegan: (() -> Void)?
    var onInterruptionEnded: ((_ shouldResume: Bool) -> Void)?

    /// Callback for route changes (headphones plugged/unplugged, BT)
    var onRouteChange: ((_ reason: AVAudioSession.RouteChangeReason) -> Void)?

    @Published private(set) var currentOutputs: [AudioRouteDescriptor] = []
    @Published private(set) var currentInput: AudioRouteDescriptor?
    @Published private(set) var availableInputs: [AudioRouteDescriptor] = []

    init() {
        setupEngine()
        registerNotifications()
        refreshRouteSnapshot()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - Audio Session

    /// Configure the shared audio session for turn-based voice interaction.
    ///
    /// Important: avoid call-style routing (`voiceChat` / HFP), because car
    /// stereos can interpret that as an active phone call and reject CarPlay or
    /// media Bluetooth output changes. We want media playback routes for Claudia
    /// while still recording from the phone's microphone between responses.
    func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [
                .allowBluetoothA2DP,
                .allowAirPlay,
                .defaultToSpeaker
            ])
            try session.setPreferredInputNumberOfChannels(1)
            if let builtInMic = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
                try session.setPreferredInput(builtInMic)
            }
            try session.setActive(true)
            refreshRouteSnapshot()
            print("[AudioSession] Configured: playAndRecord + media routes + built-in mic preference")
        } catch {
            print("[AudioSession] Configuration error: \(error)")
        }
    }

    // MARK: - Engine Lifecycle

    /// Start the shared engine. Called once on app start — stays running
    /// throughout the entire voice conversation.
    func startEngine() {
        guard !engine.isRunning else { return }
        do {
            try engine.start()
            print("[AudioSession] Engine started")
        } catch {
            print("[AudioSession] Engine start failed: \(error)")
        }
    }

    /// Ensure engine is running (idempotent, safe to call anytime)
    func ensureEngineRunning() {
        if !engine.isRunning {
            startEngine()
        }
    }

    /// Stop the engine completely. Only call on app teardown.
    func stopEngine() {
        if micTapInstalled {
            disableMicInput()
        }
        playerNode.stop()
        engine.stop()
        print("[AudioSession] Engine stopped")
    }

    // MARK: - Mic Input (tap management)

    /// Install an input tap for speech recognition.
    /// Engine stays running — just adds the tap.
    @discardableResult
    func enableMicInput(bufferSize: AVAudioFrameCount = 1024,
                        handler: @escaping (AVAudioPCMBuffer, AVAudioTime) -> Void) -> Bool {
        guard !micTapInstalled else {
            print("[AudioSession] Mic tap already installed")
            return true
        }

        ensureEngineRunning()

        let inputNode = engine.inputNode
        // Some routes can temporarily report an invalid input format (0 channels/sample rate).
        // Validate before installing tap to avoid AVFAudio runtime assertions.
        let preferredFormat = inputNode.outputFormat(forBus: 0)
        let fallbackFormat = inputNode.inputFormat(forBus: 0)
        print("[AudioSession] Input formats - output: \(preferredFormat.sampleRate)Hz/\(preferredFormat.channelCount)ch, input: \(fallbackFormat.sampleRate)Hz/\(fallbackFormat.channelCount)ch")
        let recordingFormat = (preferredFormat.channelCount > 0 && preferredFormat.sampleRate > 0)
            ? preferredFormat
            : fallbackFormat

        guard recordingFormat.channelCount > 0, recordingFormat.sampleRate > 0 else {
            // Attempt to recover by forcing built-in mic route and re-reading format.
            let session = AVAudioSession.sharedInstance()
            if let builtInMic = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
                try? session.setPreferredInput(builtInMic)
                try? session.setActive(true)
            }
            // Rebuild the engine graph to force input format re-negotiation.
            engine.stop()
            engine.reset()
            startEngine()

            let retryFormat = engine.inputNode.inputFormat(forBus: 0)
            print("[AudioSession] Retry input format: \(retryFormat.sampleRate)Hz/\(retryFormat.channelCount)ch")
            if retryFormat.channelCount > 0, retryFormat.sampleRate > 0 {
                engine.inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: retryFormat) { buffer, time in
                    handler(buffer, time)
                }
                micTapInstalled = true
                print("[AudioSession] Mic input enabled (recovered)")
                return true
            }
            print("[AudioSession] Mic input unavailable (invalid format)")
            return false
        }

        inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: recordingFormat) { buffer, time in
            handler(buffer, time)
        }

        micTapInstalled = true
        print("[AudioSession] Mic input enabled")
        return true
    }

    /// Remove the input tap. Engine stays running.
    func disableMicInput() {
        guard micTapInstalled else { return }
        engine.inputNode.removeTap(onBus: 0)
        micTapInstalled = false
        print("[AudioSession] Mic input disabled")
    }

    // MARK: - Playback

    /// Schedule a buffer on the shared player node.
    /// Returns the number of currently scheduled buffers (for tracking).
    @discardableResult
    func scheduleBuffer(_ buffer: AVAudioPCMBuffer,
                        completionHandler: @escaping () -> Void) -> Bool {
        ensureEngineRunning()

        playerNode.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in
            completionHandler()
        }

        if !playerNode.isPlaying {
            playerNode.play()
        }

        return true
    }

    /// Stop the player node and clear pending buffers. Engine stays running.
    func stopPlayback() {
        playerNode.stop()
        playerNode.reset()
        print("[AudioSession] Playback stopped")
    }

    func playTestChime(completion: @escaping (Bool) -> Void) {
        ensureEngineRunning()

        guard let buffer = makeTestChimeBuffer() else {
            completion(false)
            return
        }

        stopPlayback()
        scheduleBuffer(buffer) {
            DispatchQueue.main.async {
                completion(true)
            }
        }
    }

    func refreshRouteSnapshot() {
        let session = AVAudioSession.sharedInstance()
        let route = session.currentRoute

        DispatchQueue.main.async {
            self.currentOutputs = route.outputs.map(Self.describePort)
            self.currentInput = route.inputs.first.map(Self.describePort)
            self.availableInputs = (session.availableInputs ?? []).map(Self.describePort)
        }
    }

    // MARK: - Scene Phase

    /// Call when app enters foreground
    func handleSceneActive() {
        ensureEngineRunning()
        print("[AudioSession] Scene active — engine ensured running")
    }

    /// Call when app enters background. Engine keeps running
    /// (UIBackgroundModes=audio in Info.plist).
    func handleSceneBackground() {
        print("[AudioSession] Scene background — engine continues running")
    }

    // MARK: - Private

    private func setupEngine() {
        engine.attach(playerNode)
        engine.connect(playerNode, to: engine.mainMixerNode, format: playerFormat)
        print("[AudioSession] Engine configured with player node")
    }

    private func makeTestChimeBuffer() -> AVAudioPCMBuffer? {
        let durationSeconds = 0.65
        let sampleRate = playerFormat.sampleRate
        let frameCount = AVAudioFrameCount(durationSeconds * sampleRate)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: playerFormat, frameCapacity: frameCount),
              let channelData = buffer.floatChannelData?[0] else {
            return nil
        }

        buffer.frameLength = frameCount

        for frame in 0..<Int(frameCount) {
            let t = Double(frame) / sampleRate
            let progress = t / durationSeconds
            let envelope = max(0.0, 1.0 - progress)
            let frequency = progress < 0.5 ? 880.0 : 1320.0
            let sample = sin(2.0 * .pi * frequency * t) * envelope * 0.28
            channelData[frame] = Float(sample)
        }

        return buffer
    }

    nonisolated private static func describePort(_ port: AVAudioSessionPortDescription) -> AudioRouteDescriptor {
        AudioRouteDescriptor(
            id: port.uid,
            name: port.portName,
            detail: friendlyName(for: port.portType)
        )
    }

    nonisolated private static func friendlyName(for portType: AVAudioSession.Port) -> String {
        switch portType {
        case .builtInSpeaker:
            return "Built-in speaker"
        case .builtInReceiver:
            return "Phone receiver"
        case .builtInMic:
            return "Built-in microphone"
        case .headphones:
            return "Wired headphones"
        case .headsetMic:
            return "Headset microphone"
        case .bluetoothA2DP:
            return "Bluetooth audio"
        case .bluetoothHFP:
            return "Bluetooth hands-free"
        case .bluetoothLE:
            return "Bluetooth LE audio"
        case .carAudio:
            return "Car audio / CarPlay"
        case .airPlay:
            return "AirPlay"
        case .HDMI:
            return "HDMI"
        case .usbAudio:
            return "USB audio"
        default:
            return portType.rawValue
        }
    }

    private func registerNotifications() {
        let nc = NotificationCenter.default

        nc.addObserver(self,
                       selector: #selector(handleInterruption),
                       name: AVAudioSession.interruptionNotification,
                       object: AVAudioSession.sharedInstance())

        nc.addObserver(self,
                       selector: #selector(handleRouteChange),
                       name: AVAudioSession.routeChangeNotification,
                       object: AVAudioSession.sharedInstance())
    }

    @objc private func handleInterruption(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }

        switch type {
        case .began:
            print("[AudioSession] Interruption began (phone call, Siri, etc.)")
            DispatchQueue.main.async { self.onInterruptionBegan?() }

        case .ended:
            let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
            let shouldResume = options.contains(.shouldResume)
            print("[AudioSession] Interruption ended (shouldResume: \(shouldResume))")

            if shouldResume {
                // Reactivate session and restart engine
                do {
                    try AVAudioSession.sharedInstance().setActive(true)
                    startEngine()
                } catch {
                    print("[AudioSession] Failed to reactivate after interruption: \(error)")
                }
            }

            DispatchQueue.main.async { self.onInterruptionEnded?(shouldResume) }

        @unknown default:
            break
        }
    }

    @objc private func handleRouteChange(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
            return
        }

        print("[AudioSession] Route change: \(reason.rawValue)")
        refreshRouteSnapshot()

        switch reason {
        case .oldDeviceUnavailable:
            // Headphones unplugged — pause playback (Apple HIG)
            print("[AudioSession] Output device removed — stopping playback")
            DispatchQueue.main.async { self.stopPlayback() }
        case .newDeviceAvailable:
            print("[AudioSession] New output device available")
        default:
            break
        }

        DispatchQueue.main.async { self.onRouteChange?(reason) }
    }
}
