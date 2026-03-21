import SwiftUI

struct VoiceModeView: View {
    let appState: AppState

    // Pulse animation
    @State private var pulseScale: CGFloat = 1.0
    @State private var pulseOpacity: Double = 0.6

    // Browser sheet
    @State private var showBrowser = false
    @State private var showSettings = false

    // Claudia's purple
    private let accentColor = Color(red: 0.533, green: 0.4, blue: 0.867)

    var body: some View {
        ZStack {
            // Background
            Color.black.ignoresSafeArea()

            VStack(spacing: 32) {
                // Top bar: connection indicator + actions
                HStack {
                    // Connection indicator
                    HStack(spacing: 8) {
                        Circle()
                            .fill(appState.isConnected ? Color.green : Color.red)
                            .frame(width: 8, height: 8)
                        Text(appState.isConnected ? "Connected" : "Disconnected")
                            .font(.caption)
                            .foregroundColor(.gray)
                    }

                    Spacer()

                    Button(action: { showSettings = true }) {
                        Image(systemName: "gearshape")
                            .font(.system(size: 20))
                            .foregroundColor(accentColor)
                    }

                    // Browser button
                    Button(action: { showBrowser = true }) {
                        Image(systemName: "safari")
                            .font(.system(size: 20))
                            .foregroundColor(accentColor)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 8)

                Spacer()

                // Pulse rings (behind button)
                ZStack {
                    if appState.voiceState == .listening {
                        ForEach(0..<3, id: \.self) { i in
                            Circle()
                                .stroke(accentColor.opacity(0.3), lineWidth: 2)
                                .frame(width: 160 + CGFloat(i) * 40,
                                       height: 160 + CGFloat(i) * 40)
                                .scaleEffect(pulseScale)
                                .opacity(pulseOpacity)
                                .animation(
                                    .easeInOut(duration: 1.5)
                                    .repeatForever(autoreverses: true)
                                    .delay(Double(i) * 0.3),
                                    value: pulseScale
                                )
                        }
                    }

                    if appState.voiceState == .speaking {
                        ForEach(0..<3, id: \.self) { i in
                            Circle()
                                .stroke(accentColor.opacity(0.5), lineWidth: 3)
                                .frame(width: 160 + CGFloat(i) * 40,
                                       height: 160 + CGFloat(i) * 40)
                                .scaleEffect(1.0 + CGFloat.random(in: 0...0.1))
                                .animation(
                                    .easeInOut(duration: 0.3)
                                    .repeatForever(autoreverses: true),
                                    value: appState.audioPlayer.isPlaying
                                )
                        }
                    }

                    // Big mic button
                    Button(action: { appState.toggleListening() }) {
                        ZStack {
                            Circle()
                                .fill(buttonColor)
                                .frame(width: 140, height: 140)
                                .shadow(color: accentColor.opacity(0.5), radius: 20)

                            Image(systemName: buttonIcon)
                                .font(.system(size: 50, weight: .medium))
                                .foregroundColor(.white)
                        }
                    }
                    .buttonStyle(.plain)
                }

                // Status text
                Text(appState.statusText)
                    .font(.title2)
                    .fontWeight(.medium)
                    .foregroundColor(.white)

                // Current transcript (while listening)
                if appState.voiceState == .listening && !appState.speechRecognizer.currentTranscript.isEmpty {
                    Text(appState.speechRecognizer.currentTranscript)
                        .font(.body)
                        .foregroundColor(.gray)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 40)
                        .lineLimit(3)
                }

                Spacer()
            }
        }
        .onAppear {
            // Start pulse animation
            pulseScale = 1.15
            pulseOpacity = 0.2
        }
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showBrowser) {
            BrowserView(browser: appState.browser)
        }
        .sheet(isPresented: $showSettings) {
            VoiceSettingsView(appState: appState)
        }
    }

    private var buttonColor: Color {
        switch appState.voiceState {
        case .idle:
            return .gray.opacity(0.5)
        case .listening:
            return accentColor
        case .processing:
            return .orange.opacity(0.7)
        case .speaking:
            return .red.opacity(0.7)
        }
    }

    private var buttonIcon: String {
        switch appState.voiceState {
        case .idle:
            return "mic.slash"
        case .listening:
            return "mic"
        case .processing:
            return "ellipsis"
        case .speaking:
            return "stop.fill"
        }
    }
}

private struct VoiceSettingsView: View {
    let appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var host: String
    @State private var cwd: String

    init(appState: AppState) {
        self.appState = appState
        _host = State(initialValue: appState.gatewayHost)
        _cwd = State(initialValue: appState.workspaceCwd)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Gateway") {
                    TextField("gateway.anima-sedes.com", text: $host)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Text("The app always connects using wss://<host>/ws.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("Workspace") {
                    TextField("/Users/claudia/chat", text: $cwd)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Text("Voice Mode marks this workspace as general so archived summaries can span all workspaces.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        appState.saveGatewaySettings(host: host, cwd: cwd)
                        dismiss()
                    }
                }
            }
        }
    }
}
