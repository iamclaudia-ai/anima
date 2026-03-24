import SwiftUI

/**
 * Settings panel for configuring the menubar app.
 *
 * All values persist via UserDefaults (accessed via @AppStorage).
 * Changes take effect on next connection / next prompt.
 */
struct SettingsView: View {
    @AppStorage("gatewayURL") private var gatewayURL = "ws://localhost:30086/ws"
    @AppStorage("cwd") private var cwd = ""
    @AppStorage("model") private var model = "claude-sonnet-4-20250514"
    @AppStorage("wakeWordEnabled") private var wakeWordEnabled = true
    @AppStorage("autoSpeak") private var autoSpeak = true

    @Environment(\.dismiss) private var dismiss

    private let models = [
        "claude-sonnet-4-20250514",
        "claude-opus-4-20250514",
    ]

    var body: some View {
        Form {
            Section("Gateway") {
                TextField("Gateway URL", text: $gatewayURL)
                    .textFieldStyle(.roundedBorder)
                    .help("WebSocket URL for the Anima gateway")

                TextField("Working Directory", text: $cwd, prompt: Text("~ (home directory)"))
                    .textFieldStyle(.roundedBorder)
                    .help("Working directory for sessions. Leave empty for home directory.")
            }

            Section("Model") {
                Picker("Model", selection: $model) {
                    ForEach(models, id: \.self) { m in
                        Text(m).tag(m)
                    }
                }
            }

            Section("Voice") {
                Toggle("Wake Word Detection", isOn: $wakeWordEnabled)
                    .help("Listen for \"Hey babe\" to activate voice input")
                Toggle("Auto-speak Responses", isOn: $autoSpeak)
                    .help("Automatically speak responses using TTS")
            }

            Section {
                HStack {
                    Spacer()
                    Button("Done") { dismiss() }
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 400)
        .padding()
    }
}

#Preview {
    SettingsView()
}
