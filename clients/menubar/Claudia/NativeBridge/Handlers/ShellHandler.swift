import Foundation

/**
 * Execute shell commands via /bin/zsh.
 *
 * Runs a command and returns stdout, stderr, and exit code.
 * Useful when AppleScript is overkill and you just need to run a CLI tool.
 *
 * Params:
 *   - command: String (required) — the shell command to execute
 *   - cwd: String? — working directory (default: home directory)
 *   - timeout: Int? — timeout in seconds (default: 30)
 */
struct ShellHandler: NativeHandler {
    static let command = "shell"
    static let description = "Execute a shell command and return output"

    static func handle(
        params: [String: Any],
        completion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
        guard let command = params["command"] as? String else {
            completion(.failure(NativeBridgeError.missingParam("command")))
            return
        }

        let timeout = params["timeout"] as? Int ?? 30
        let cwd = params["cwd"] as? String

        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/zsh")
            process.arguments = ["-c", command]

            if let cwd = cwd {
                process.currentDirectoryURL = URL(fileURLWithPath: (cwd as NSString).expandingTildeInPath)
            }

            // Inherit environment from the app
            process.environment = ProcessInfo.processInfo.environment

            let stdout = Pipe()
            let stderr = Pipe()
            process.standardOutput = stdout
            process.standardError = stderr

            do {
                try process.run()
            } catch {
                completion(.failure(NativeBridgeError.executionFailed(error.localizedDescription)))
                return
            }

            // Timeout handling
            let timer = DispatchSource.makeTimerSource(queue: .global())
            timer.schedule(deadline: .now() + .seconds(timeout))
            timer.setEventHandler {
                if process.isRunning {
                    process.terminate()
                    print("[NativeBridge] Shell command timed out after \(timeout)s")
                }
            }
            timer.resume()

            process.waitUntilExit()
            timer.cancel()

            let stdoutData = stdout.fileHandleForReading.readDataToEndOfFile()
            let stderrData = stderr.fileHandleForReading.readDataToEndOfFile()

            let stdoutText = String(data: stdoutData, encoding: .utf8) ?? ""
            let stderrText = String(data: stderrData, encoding: .utf8) ?? ""
            let exitCode = Int(process.terminationStatus)

            print("[NativeBridge] Shell exit=\(exitCode): \(command.prefix(60))")
            completion(.success([
                "stdout": stdoutText,
                "stderr": stderrText,
                "exitCode": exitCode,
            ]))
        }
    }
}
