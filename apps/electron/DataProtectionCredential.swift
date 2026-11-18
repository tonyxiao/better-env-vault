import Foundation
import Security

private let accessGroup = "H82Z395PDV.com.tonyxiao.codex-keychain-helper"
private let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: "1Password Service Account Token",
  kSecAttrAccount as String: "money-redux",
  kSecAttrAccessGroup as String: accessGroup,
  kSecUseDataProtectionKeychain as String: true,
  kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
  kSecReturnData as String: true,
  kSecMatchLimit as String: kSecMatchLimitOne,
]

guard
  let task = SecTaskCreateFromSelf(nil),
  let groups = SecTaskCopyValueForEntitlement(
    task, "keychain-access-groups" as CFString, nil
  ) as? [String],
  groups.contains(accessGroup)
else { exit(2) }

var result: CFTypeRef?
guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
  var token = result as? Data,
  token.count <= 65_536
else { exit(3) }
defer { token.resetBytes(in: 0..<token.count) }

guard let value = String(data: token, encoding: .utf8),
  value.hasPrefix("ops_"),
  !value.contains("\n"),
  !value.contains("\r"),
  !value.contains("\0")
else { exit(4) }

FileHandle.standardOutput.write(token)
