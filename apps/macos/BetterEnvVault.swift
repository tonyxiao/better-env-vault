import AppKit
import Darwin
import Security
import WebKit

// No state restoration, preferences, URL credentials, disk cache, or payload logging.
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
  var window: NSWindow!
  var web: WKWebView?
  var child: Process?
  var input: Pipe?
  var origin: URL?
  var generation = 0
  var quitting = false
  var verifying = CommandLine.arguments.contains("--verify")
  var verified = false
  var verificationSucceeded = false
  var terminationSignals: [DispatchSourceSignal] = []
  var verificationState = "STARTUP"
  var schemas: [String] = []
  var discovery: [String: String] = [:]
  var tokenField: NSSecureTextField?
  var connectButton: NSButton?
  var connectionPath: String?
  var connectionHandle: FileHandle?
  var pendingConnectionToken: String?
  var connectionFailed = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    var limit = rlimit(rlim_cur: 0, rlim_max: 0)
    setrlimit(RLIMIT_CORE, &limit)
    for value in [SIGTERM, SIGINT, SIGHUP] {
      signal(value, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: value, queue: .main)
      source.setEventHandler { NSApplication.shared.terminate(nil) }
      source.resume()
      terminationSignals.append(source)
    }
    NSApplication.shared.setActivationPolicy(.regular)
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "Better Env Vault"
    window.isRestorable = false
    window.center()
    let menu = NSMenu()
    let appItem = NSMenuItem()
    menu.addItem(appItem)
    let appMenu = NSMenu()
    appItem.submenu = appMenu
    appMenu.addItem(withTitle: "Refresh", action: #selector(refresh), keyEquivalent: "r").target =
      self
    appMenu.addItem(withTitle: "Open Schema…", action: #selector(openSchema), keyEquivalent: "o")
      .target = self
    appMenu.addItem(withTitle: "Browse Vaults", action: #selector(browseVaults), keyEquivalent: "b")
      .target = self
    appMenu.addItem(
      withTitle: "Service Account…", action: #selector(configureServiceAccount), keyEquivalent: ","
    )
    .target = self
    appMenu.addItem(.separator())
    appMenu.addItem(
      withTitle: "Quit Better Env Vault", action: #selector(NSApplication.terminate(_:)),
      keyEquivalent: "q")
    let editItem = NSMenuItem()
    menu.addItem(editItem)
    let edit = NSMenu(title: "Edit")
    editItem.submenu = edit
    for (title, action, key) in [
      ("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"),
      ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a"),
    ] {
      edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
    }
    NSApplication.shared.mainMenu = menu
    let args = Array(CommandLine.arguments.dropFirst())
    var index = 0
    while index < args.count {
      let flag = args[index]
      if flag == "--verify" {
        index += 1
        continue
      }
      guard index + 1 < args.count else {
        fail()
        return
      }
      let value = args[index + 1]
      switch flag {
      case "--connect-socket": connectionPath = value
      case "--schema": schemas.append(value)
      case "--auth":
        guard ["desktop", "service-account"].contains(value) else {
          fail()
          return
        }
        discovery["auth"] = value
      case "--account": discovery["account"] = value
      case "--service-account-keychain": discovery["serviceAccountKeychain"] = value
      default:
        fail()
        return
      }
      index += 2
    }
    if verifying {
      FileHandle.standardOutput.write(Data("APP_VERIFICATION_PID \(getpid())\n".utf8))
    }
    window.makeKeyAndOrderFront(nil)
    NSApplication.shared.activate(ignoringOtherApps: true)
    if let path = connectionPath { receiveConnection(path) } else { start() }
  }

  func status(_ text: String) {
    let label = NSTextField(wrappingLabelWithString: text)
    label.alignment = .center
    label.frame = NSRect(x: 40, y: 320, width: 1100, height: 100)
    let view = NSView()
    view.addSubview(label)
    window.contentView = view
  }

  func fail() {
    status(
      "Unable to open Better Env Vault. Check 1Password authorization, then use Refresh to retry.")
    if connectionPath != nil {
      finishConnection(false)
    } else if verifying {
      finishVerification(false)
    }
  }

  func stop() {
    generation += 1
    web?.stopLoading()
    web?.configuration.userContentController.removeAllUserScripts()
    web?.navigationDelegate = nil
    web = nil
    origin = nil
    tokenField?.stringValue = ""
    tokenField = nil
    connectButton = nil
    input?.fileHandleForWriting.closeFile()
    input = nil
    if let process = child, process.isRunning {
      process.terminate()
      // Bounded shutdown even while the SDK is waiting for authorization.
      let deadline = Date().addingTimeInterval(2)
      while process.isRunning && Date() < deadline { usleep(10_000) }
      if process.isRunning { kill(process.processIdentifier, SIGKILL) }
      process.waitUntilExit()
    }
    child = nil
  }

  @objc func refresh() { start() }
  @objc func browseVaults() {
    schemas = []
    start()
  }
  @objc func openSchema() {
    let panel = NSOpenPanel()
    panel.showsHiddenFiles = true
    panel.allowsMultipleSelection = true
    panel.canChooseDirectories = false
    if panel.runModal() == .OK {
      schemas = panel.urls.map(\.path)
      start()
    }
  }

  @objc func configureServiceAccount() {
    schemas = []
    discovery["auth"] = "service-account"
    start(configureServiceAccount: true)
  }

  func showServiceAccountSetup(error: Bool = false) {
    if connectionPath != nil {
      guard !error, let token = pendingConnectionToken, let pipe = input else {
        finishConnection(false)
        return
      }
      pendingConnectionToken = nil
      do {
        var data = try JSONSerialization.data(withJSONObject: ["serviceAccountToken": token])
        defer { data.resetBytes(in: 0..<data.count) }
        data.append(10)
        try pipe.fileHandleForWriting.write(contentsOf: data)
      } catch { finishConnection(false) }
      return
    }
    if verifying {
      verificationState = "SERVICE_ACCOUNT_REQUIRED"
      finishVerification(false)
      return
    }
    let view = NSView(frame: window.contentView!.bounds)
    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 16
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    let title = NSTextField(labelWithString: "Connect to 1Password")
    title.font = .systemFont(ofSize: 24, weight: .semibold)
    stack.addArrangedSubview(title)
    let explanation = NSTextField(
      wrappingLabelWithString:
        "Enter a 1Password service-account token with access to your vaults. Better Env Vault connects directly through the SDK; the 1Password desktop app and CLI are not required. The token is stored only in macOS Keychain."
    )
    stack.addArrangedSubview(explanation)
    let field = NSSecureTextField()
    field.placeholderString = "Service-account token (ops_…)"
    field.translatesAutoresizingMaskIntoConstraints = false
    field.widthAnchor.constraint(equalToConstant: 540).isActive = true
    field.target = self
    field.action = #selector(connectServiceAccount)
    stack.addArrangedSubview(field)
    tokenField = field
    if error {
      let message = NSTextField(
        wrappingLabelWithString:
          "Could not store the token. Use a valid service-account token, unlock macOS Keychain, and allow access if prompted."
      )
      message.textColor = .systemRed
      stack.addArrangedSubview(message)
    }
    let button = NSButton(title: "Connect", target: self, action: #selector(connectServiceAccount))
    button.bezelStyle = .rounded
    stack.addArrangedSubview(button)
    connectButton = button
    let hint = NSTextField(
      wrappingLabelWithString:
        "Create a scoped service account at my.1password.com → Developer → Service Accounts. You can replace the token later from the Service Account menu."
    )
    hint.textColor = .secondaryLabelColor
    stack.addArrangedSubview(hint)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      stack.widthAnchor.constraint(equalToConstant: 540),
    ])
    window.contentView = view
    window.makeFirstResponder(field)
  }

  @objc func connectServiceAccount() {
    guard let field = tokenField, let pipe = input, connectButton?.isEnabled == true else { return }
    do {
      var data = try JSONSerialization.data(withJSONObject: [
        "serviceAccountToken": field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
      ])
      defer { data.resetBytes(in: 0..<data.count) }
      field.stringValue = ""
      field.currentEditor()?.undoManager?.removeAllActions()
      field.isEnabled = false
      connectButton?.isEnabled = false
      data.append(10)
      try pipe.fileHandleForWriting.write(contentsOf: data)
    } catch {
      field.stringValue = ""
      showServiceAccountSetup(error: true)
    }
  }

  // An owner-only Unix socket lets the signed installer supply a token directly
  // to this GUI process. Tokens never enter arguments, URLs, or files.
  func receiveConnection(_ path: String) {
    status("Connecting service account…")
    discovery["auth"] = "service-account"
    DispatchQueue.global().async { [weak self] in
      do {
        let attributes = try FileManager.default.attributesOfItem(atPath: path)
        guard attributes[.type] as? FileAttributeType == .typeSocket,
          (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
          ((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o077 == 0
        else { throw NSError(domain: "Connection", code: 1) }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw NSError(domain: "Connection", code: 1) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
          close(fd)
          throw NSError(domain: "Connection", code: 1)
        }
        _ = withUnsafeMutablePointer(to: &address.sun_path) { pointer in
          bytes.withUnsafeBufferPointer { source in
            memcpy(pointer, source.baseAddress!, bytes.count)
          }
        }
        let result = withUnsafePointer(to: &address) { pointer in
          pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
          }
        }
        guard result == 0 else {
          close(fd)
          throw NSError(domain: "Connection", code: 1)
        }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        var data = Data()
        while true {
          let chunk = handle.readData(ofLength: 4096)
          if chunk.isEmpty { break }
          data.append(chunk)
          guard data.count <= 65536 else {
            handle.closeFile()
            throw NSError(domain: "Connection", code: 1)
          }
        }
        defer { data.resetBytes(in: 0..<data.count) }
        guard let token = String(data: data, encoding: .utf8), token.hasPrefix("ops_") else {
          handle.closeFile()
          throw NSError(domain: "Connection", code: 1)
        }
        DispatchQueue.main.async {
          guard let self else {
            handle.closeFile()
            return
          }
          self.connectionHandle = handle
          self.pendingConnectionToken = token
          self.start(configureServiceAccount: true)
        }
      } catch { DispatchQueue.main.async { self?.finishConnection(false) } }
    }
  }

  func finishConnection(_ success: Bool) {
    connectionFailed = !success
    try? connectionHandle?.write(contentsOf: Data((success ? "OK" : "ERROR").utf8))
    connectionHandle?.closeFile()
    connectionHandle = nil
    pendingConnectionToken = nil
    NSApplication.shared.terminate(nil)
  }

  // Existing headless service account, shared by the signed tools on this Mac.
  // Query only this exact item; never enumerate credentials or expose a JS bridge.
  func dataProtectionServiceAccountToken() -> String? {
    guard let task = SecTaskCreateFromSelf(nil),
      let groups = SecTaskCopyValueForEntitlement(task, "keychain-access-groups" as CFString, nil)
        as? [String],
      groups.contains("H82Z395PDV.com.tonyxiao.codex-keychain-helper")
    else { return nil }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "1Password Service Account Token",
      kSecAttrAccount as String: "money-redux",
      kSecAttrAccessGroup as String: "H82Z395PDV.com.tonyxiao.codex-keychain-helper",
      kSecUseDataProtectionKeychain as String: true,
      kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      var data = result as? Data
    else { return nil }
    defer { data.resetBytes(in: 0..<data.count) }
    guard let token = String(data: data, encoding: .utf8),
      token.hasPrefix("ops_"), token.utf8.count <= 65536,
      !token.contains("\n"), !token.contains("\r"), !token.contains("\0")
    else { return nil }
    return token
  }

  func start(configureServiceAccount: Bool = false) {
    stop()
    status("Loading Better Env Vault…")
    let current = generation
    guard let resources = Bundle.main.resourceURL else {
      fail()
      return
    }
    let process = Process()
    let incoming = Pipe()
    let outgoing = Pipe()
    process.executableURL = resources.appendingPathComponent("runtime/bin/node")
    process.arguments = [resources.appendingPathComponent("app/dist/apps/macos/server.js").path]
    // Deliberately do not inherit NODE_OPTIONS, debugging/report flags, or SDK logging settings.
    var environment = [
      "HOME": NSHomeDirectory(), "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      "LANG": "en_US.UTF-8",
    ]
    for key in ["OP_ACCOUNT", "OP_SERVICE_ACCOUNT_TOKEN"] {
      if let value = ProcessInfo.processInfo.environment[key] { environment[key] = value }
    }
    if discovery["auth"] != "desktop", discovery["serviceAccountKeychain"] == nil,
      environment["OP_SERVICE_ACCOUNT_TOKEN"] == nil, !configureServiceAccount,
      let token = dataProtectionServiceAccountToken()
    {
      environment["BEV_DATA_PROTECTION_SERVICE_ACCOUNT_TOKEN"] = token
    }
    process.environment = environment
    process.currentDirectoryURL = resources.appendingPathComponent("app")
    process.standardInput = incoming
    process.standardOutput = outgoing
    process.standardError = FileHandle.nullDevice
    process.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        guard let self, self.generation == current, !self.quitting else { return }
        self.fail()
      }
    }
    do {
      let config: [String: Any] =
        schemas.isEmpty
        ? [
          "schemas": [], "discovery": discovery, "configureServiceAccount": configureServiceAccount,
        ]
        : ["schemas": schemas]
      let data = try JSONSerialization.data(withJSONObject: config)
      try process.run()
      outgoing.fileHandleForWriting.closeFile()
      incoming.fileHandleForReading.closeFile()
      child = process
      input = incoming
      incoming.fileHandleForWriting.write(data + Data([10]))
      DispatchQueue.global().async { [weak self] in
        // Read only fixed setup states and the bounded readiness record.
        while true {
          var data = Data()
          while data.count < 2048 {
            let byte = outgoing.fileHandleForReading.readData(ofLength: 1)
            if byte.isEmpty { return }
            if byte == Data([10]) { break }
            data.append(byte)
          }
          guard data.count < 2048,
            let record = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
          else { return }
          DispatchQueue.main.async {
            guard let self, self.generation == current else { return }
            if record["setupRequired"] as? Bool == true {
              self.showServiceAccountSetup(error: record["error"] as? Bool == true)
              return
            }
            guard let address = record["url"] as? String, let url = URL(string: address),
              url.host == "127.0.0.1", url.scheme == "http", url.port != nil,
              let bootstrap = record["bootstrap"] as? String, bootstrap.count == 64,
              bootstrap.allSatisfy({ $0.isHexDigit })
            else {
              self.fail()
              return
            }
            self.tokenField = nil
            self.connectButton = nil
            if self.connectionPath != nil {
              self.finishConnection(true)
              return
            }
            self.load(url, bootstrap: bootstrap)
          }
        }
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 90) { [weak self] in
        guard let self, self.generation == current, self.verifying, !self.verified else { return }
        self.finishVerification(false)
      }
    } catch { fail() }
  }

  func load(_ url: URL, bootstrap: String) {
    origin = url
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.preferences.javaScriptCanOpenWindowsAutomatically = false
    config.userContentController.addUserScript(
      WKUserScript(
        source:
          "Object.defineProperty(window, '__bevBootstrap', {value: '\(bootstrap)', configurable: true});",
        injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let view = WKWebView(frame: window.contentView!.bounds, configuration: config)
    view.autoresizingMask = [.width, .height]
    view.navigationDelegate = self
    view.allowsBackForwardNavigationGestures = false
    web = view
    window.contentView = view
    view.load(URLRequest(url: url))
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    let url = navigationAction.request.url
    let allowed =
      url?.scheme == origin?.scheme && url?.host == origin?.host && url?.port == origin?.port
    decisionHandler(allowed && navigationAction.targetFrame?.isMainFrame == true ? .allow : .cancel)
  }
  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) { fail() }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { start() }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    // Bootstrap remains only in this document's memory, never in future scripts/history.
    webView.configuration.userContentController.removeAllUserScripts()
    if verifying { verifyUI(attempt: 0) }
  }

  func verifyUI(attempt: Int) {
    guard verifying, !verified, let view = web else { return }
    // Only fixed status enums cross back to native code; payloads remain in WebKit.
    let script = """
      return (async () => {
        try {
          const session = await fetch('/api/session');
          if (!session.ok) return "SESSION_UNAVAILABLE";
          if (document.querySelectorAll('button').length === 0) return 'UI_UNAVAILABLE';
          const inventory = await fetch('/api/projects');
          if (!inventory.ok) return "INVENTORY_UNAVAILABLE";
          const data = await inventory.json();
          if (!Array.isArray(data.projects) || data.projects.length === 0) return 'INVENTORY_EMPTY';
          if (data.mode === 'schema') {
            const matrix = await fetch('/api/matrix?project=' + encodeURIComponent(data.projects[0].id));
            if (!matrix.ok) return 'INVENTORY_UNAVAILABLE';
          }
            return document.querySelectorAll('button').length > 0 ? 'OK' : 'UI_UNAVAILABLE';
        } catch { return "REQUEST_FAILED"; }
      })();
      """
    view.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] result in
      guard let self, !self.verified else { return }
      if case .success(let value) = result, let state = value as? String,
        [
          "OK", "SESSION_UNAVAILABLE", "INVENTORY_UNAVAILABLE", "INVENTORY_EMPTY", "UI_UNAVAILABLE",
          "REQUEST_FAILED",
        ].contains(state)
      {
        self.verificationState = state
      } else {
        self.verificationState = "JAVASCRIPT_FAILED"
      }
      if self.verificationState == "OK" {
        self.finishVerification(true)
      } else if self.verificationState == "INVENTORY_UNAVAILABLE"
        || self.verificationState == "INVENTORY_EMPTY"
      {
        self.finishVerification(false)
      } else if attempt < 60 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.verifyUI(attempt: attempt + 1) }
      } else {
        self.finishVerification(false)
      }
    }
  }
  func finishVerification(_ success: Bool) {
    guard !verified else { return }
    verified = true
    FileHandle.standardOutput.write(
      Data(
        (success
          ? "UI_AND_AUTHENTICATED_INVENTORY_OK\n"
          : "APP_VERIFICATION_FAILED: \(verificationState)\n").utf8))
    verificationSucceeded = success
    NSApplication.shared.terminate(nil)
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
  func applicationWillTerminate(_ notification: Notification) {
    quitting = true
    stop()
    if connectionPath != nil { exit(connectionFailed ? 1 : 0) }
    if verifying { exit(verificationSucceeded ? 0 : 1) }
  }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
