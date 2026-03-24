import Foundation
import AppKit
import IOKit.ps

/**
 * System information handler.
 *
 * Returns useful macOS system info — no permissions required.
 *
 * Params: none required
 *
 * Returns: hostname, macOS version, uptime, frontmost app, display count, memory, etc.
 */
struct SystemInfoHandler: NativeHandler {
    static let command = "system_info"
    static let description = "Get macOS system information (hostname, version, battery, frontmost app)"

    static func handle(
        params: [String: Any],
        completion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
        let processInfo = ProcessInfo.processInfo
        let workspace = NSWorkspace.shared

        var info: [String: Any] = [
            "hostname": processInfo.hostName,
            "macOSVersion": processInfo.operatingSystemVersionString,
            "uptime": Int(processInfo.systemUptime),
            "processorCount": processInfo.processorCount,
            "physicalMemoryGB": Int(processInfo.physicalMemory / (1024 * 1024 * 1024)),
        ]

        // Frontmost app
        if let frontApp = workspace.frontmostApplication {
            info["frontmostApp"] = [
                "name": frontApp.localizedName ?? "Unknown",
                "bundleId": frontApp.bundleIdentifier ?? "Unknown",
                "pid": frontApp.processIdentifier,
            ] as [String: Any]
        }

        // Running apps count
        info["runningAppsCount"] = workspace.runningApplications.count

        // Display count
        info["displayCount"] = NSScreen.screens.count

        // Battery info
        if let batteryInfo = getBatteryInfo() {
            info["battery"] = batteryInfo
        }

        completion(.success(info))
    }

    private static func getBatteryInfo() -> [String: Any]? {
        guard let snapshot = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let sources = IOPSCopyPowerSourcesList(snapshot)?.takeRetainedValue() as? [CFTypeRef],
              let firstSource = sources.first,
              let description = IOPSGetPowerSourceDescription(snapshot, firstSource)?.takeUnretainedValue() as? [String: Any]
        else {
            return nil
        }

        var battery: [String: Any] = [:]
        if let capacity = description[kIOPSCurrentCapacityKey] as? Int {
            battery["percentage"] = capacity
        }
        if let isCharging = description[kIOPSIsChargingKey] as? Bool {
            battery["isCharging"] = isCharging
        }
        if let powerSource = description[kIOPSPowerSourceStateKey] as? String {
            battery["powerSource"] = powerSource
        }
        return battery.isEmpty ? nil : battery
    }
}
