import Foundation
#if canImport(FirebaseCore) && canImport(FirebaseAnalytics)
import FirebaseCore
import FirebaseAnalytics
#endif

public enum FirebaseTelemetryBridge {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var configureAttempted = false

    public static func sanitizeIdentifier(_ raw: String, maxLen: Int = 40) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        var scalars: [Character] = []
        scalars.reserveCapacity(trimmed.count)
        for ch in trimmed {
            if ch.isASCII && (ch.isLetter || ch.isNumber || ch == "_") {
                scalars.append(ch)
            } else {
                scalars.append("_")
            }
        }
        var cleaned = String(scalars)
        if cleaned.isEmpty {
            cleaned = "event"
        } else if let first = cleaned.first, first.isNumber {
            cleaned = "_" + cleaned
        }
        if cleaned.count > maxLen {
            return String(cleaned.prefix(maxLen))
        }
        return cleaned
    }

    public static func ensureConfigured() -> Bool {
        #if canImport(FirebaseCore) && canImport(FirebaseAnalytics)
        lock.lock()
        defer { lock.unlock() }
        if FirebaseApp.app() != nil {
            return true
        }
        if configureAttempted {
            return false
        }
        configureAttempted = true
        let plistPath = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist")
            ?? Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist", inDirectory: "public")
        guard let plistPath, let options = FirebaseOptions(contentsOfFile: plistPath) else {
            return false
        }
        FirebaseApp.configure(options: options)
        return FirebaseApp.app() != nil
        #else
        return false
        #endif
    }

    public static func setConsent(enabled: Bool) -> Bool {
        #if canImport(FirebaseCore) && canImport(FirebaseAnalytics)
        guard ensureConfigured() else { return false }
        let status: ConsentStatus = enabled ? .granted : .denied
        Analytics.setConsent([
            .analyticsStorage: status,
            .adStorage: status,
            .adUserData: status,
            .adPersonalization: status,
        ])
        Analytics.setAnalyticsCollectionEnabled(enabled)
        return true
        #else
        return false
        #endif
    }

    public static func setUserId(_ userId: String?) -> Bool {
        #if canImport(FirebaseCore) && canImport(FirebaseAnalytics)
        guard ensureConfigured() else { return false }
        let trimmed = userId?.trimmingCharacters(in: .whitespacesAndNewlines)
        Analytics.setUserID((trimmed?.isEmpty == false) ? trimmed : nil)
        return true
        #else
        return false
        #endif
    }

    public static func logEvent(name: String, params: [String: Any]?) -> Bool {
        #if canImport(FirebaseCore) && canImport(FirebaseAnalytics)
        guard ensureConfigured() else { return false }
        var cleanParams: [String: Any] = [:]
        if let params {
            for (rawKey, rawValue) in params {
                let key = sanitizeIdentifier(rawKey, maxLen: 40)
                if let boolValue = rawValue as? Bool {
                    cleanParams[key] = boolValue ? "true" : "false"
                } else if let numberValue = rawValue as? NSNumber {
                    cleanParams[key] = numberValue
                } else if let stringValue = rawValue as? String {
                    cleanParams[key] = String(stringValue.prefix(100))
                }
            }
        }
        Analytics.logEvent(sanitizeIdentifier(name, maxLen: 40), parameters: cleanParams)
        return true
        #else
        return false
        #endif
    }
}
