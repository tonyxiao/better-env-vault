import AppKit
import Darwin
import Security
import WebKit

struct AppSource {
  let id: String
  let label: String
  let schemas: [String]
  let discovery: [String: String]
}

struct WarmWorkspace {
  let web: WKWebView
  let child: Process
  let input: Pipe
  let origin: URL
  let generation: Int
  let parked: Date
  let refreshed: Date
}

// No state restoration, preferences, URL credentials, disk cache, or payload logging.
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
  var window: NSWindow!
  var web: WKWebView?
  var child: Process?
  var input: Pipe?
  var origin: URL?
  var generation = 0
  var nextGeneration = 0
  var refreshedAt = Date()
  var warm: [String: WarmWorkspace] = [:]
  var quitting = false
  var verifying = CommandLine.arguments.contains("--verify")
  var verified = false
  var warmVerified = false
  var verificationSucceeded = false
  var terminationSignals: [DispatchSourceSignal] = []
  var verificationState = "STARTUP"
  var verificationSource: String?
  var verificationSwitched = false
  var schemas: [String] = []
  var discovery: [String: String] = [:]
  var tokenField: NSSecureTextField?
  var connectButton: NSButton?
  var connectionPath: String?
  var connectionHandle: FileHandle?
  var pendingConnectionToken: String?
  var connectionFailed = false
  var sources: [AppSource] = []
  var selectedSource = ""
  let sourcePicker = NSPopUpButton(frame: .zero, pullsDown: false)
  let sourceMenu = NSMenu(title: "Accounts")

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
    window.isReleasedWhenClosed = false
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
    let sourcesItem = NSMenuItem(title: "Accounts", action: nil, keyEquivalent: "")
    sourcesItem.submenu = sourceMenu
    menu.addItem(sourcesItem)
    sourcePicker.target = self
    sourcePicker.action = #selector(pickSource)
    sourcePicker.setAccessibilityLabel("Environment source")
    sourcePicker.toolTip =
      "Choose a service account, desktop account, or schema workspace. Use ⌘1–9 for the first nine."
    sourcePicker.addItem(withTitle: "Loading accounts…")
    sourcePicker.isEnabled = false
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
      case "--verify-source": verificationSource = value
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

  func showContent(_ view: NSView) {
    let root = NSView(
      frame: window.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 1280, height: 820))
    let bar = NSStackView()
    bar.orientation = .horizontal
    bar.spacing = 10
    bar.translatesAutoresizingMaskIntoConstraints = false
    bar.addArrangedSubview(NSTextField(labelWithString: "Source"))
    bar.addArrangedSubview(sourcePicker)
    root.addSubview(bar)
    view.translatesAutoresizingMaskIntoConstraints = false
    root.addSubview(view)
    NSLayoutConstraint.activate([
      bar.topAnchor.constraint(equalTo: root.topAnchor, constant: 10),
      bar.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
      bar.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor, constant: -16),
      bar.heightAnchor.constraint(equalToConstant: 30),
      sourcePicker.widthAnchor.constraint(lessThanOrEqualToConstant: 700),
      view.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 10),
      view.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      view.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      view.bottomAnchor.constraint(equalTo: root.bottomAnchor),
    ])
    window.contentView = root
  }

  func storedSourceNames() -> [String] {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "com.envault.1password.service-account",
      kSecMatchLimit as String: kSecMatchLimitAll,
      kSecReturnAttributes as String: true,
      kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return [] }
    return (result as? [[String: Any]] ?? []).compactMap {
      $0[kSecAttrAccount as String] as? String
    }
  }

  func updateSources(_ record: [String: Any]) {
    guard let rows = record["sources"] as? [[String: Any]] else { return }
    let previousSources = sources
    sources = rows.compactMap { row in
      guard let id = row["id"] as? String, let label = row["label"] as? String,
        let schemas = row["schemas"] as? [String]
      else { return nil }
      return AppSource(
        id: id, label: label, schemas: schemas,
        discovery: row["discovery"] as? [String: String] ?? [:])
    }
    // Retain metadata for manually added sources and project workspaces.
    for source in previousSources where !sources.contains(where: { $0.id == source.id }) {
      sources.append(source)
    }
    selectedSource = record["selectedSource"] as? String ?? selectedSource
    sourcePicker.removeAllItems()
    sourceMenu.removeAllItems()
    for (index, source) in sources.enumerated() {
      sourcePicker.addItem(withTitle: source.label)
      sourcePicker.lastItem?.representedObject = source.id
      let item = NSMenuItem(
        title: source.label, action: #selector(menuSource),
        keyEquivalent: index < 9 ? String(index + 1) : "")
      item.keyEquivalentModifierMask = [.command]
      item.target = self
      item.representedObject = source.id
      item.state = source.id == selectedSource ? .on : .off
      sourceMenu.addItem(item)
    }
    sourcePicker.menu?.addItem(.separator())
    sourcePicker.addItem(withTitle: "Add Service Account…")
    sourcePicker.lastItem?.representedObject = "add-service"
    sourcePicker.addItem(withTitle: "Add Desktop Account…")
    sourcePicker.lastItem?.representedObject = "add-desktop"
    sourceMenu.addItem(.separator())
    sourceMenu.addItem(
      withTitle: "Add Service Account…", action: #selector(addServiceAccount), keyEquivalent: ""
    ).target = self
    sourceMenu.addItem(
      withTitle: "Add Desktop Account…", action: #selector(addDesktopAccount), keyEquivalent: ""
    ).target = self
    restoreSourceSelection()
    sourcePicker.isEnabled = true
  }

  func restoreSourceSelection() {
    if let index = sources.firstIndex(where: { $0.id == selectedSource }) {
      sourcePicker.selectItem(at: index)
    }
  }
  @objc func pickSource() {
    guard let id = sourcePicker.selectedItem?.representedObject as? String else { return }
    restoreSourceSelection()
    if id == "add-service" {
      addServiceAccount()
      return
    }
    if id == "add-desktop" {
      addDesktopAccount()
      return
    }
    chooseSource(id)
  }
  @objc func menuSource(_ sender: NSMenuItem) {
    if let id = sender.representedObject as? String { chooseSource(id) }
  }
  func allowSourceChange(_ action: @escaping () -> Void) {
    guard let view = web else {
      action()
      return
    }
    view.evaluateJavaScript("window.__bevNavigationState?.() ?? 0") { [weak self] value, error in
      guard let self else { return }
      let state = value as? Int ?? 0
      if error != nil { return }
      if state == 2 {
        let alert = NSAlert()
        alert.messageText = "Wait for the current save to finish"
        alert.informativeText = "Switching sources is unavailable while a change is being saved."
        alert.runModal()
        return
      }
      if state == 1 {
        let alert = NSAlert()
        alert.messageText = "Discard unsaved drafts?"
        alert.informativeText =
          "Switching sources closes this workspace. Unsaved drafts will be discarded."
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Discard and Switch")
        guard alert.runModal() == .alertSecondButtonReturn else { return }
        self.stop()
      }
      action()
    }
  }
  func chooseSource(_ id: String) {
    guard id != selectedSource, let source = sources.first(where: { $0.id == id }) else { return }
    allowSourceChange { [weak self] in
      guard let self else { return }
      self.parkWorkspace()
      self.schemas = source.schemas
      self.discovery = source.discovery
      self.selectedSource = source.id
      self.restoreSourceSelection()
      for item in self.sourceMenu.items {
        item.state = item.representedObject as? String == source.id ? .on : .off
      }
      if !self.restoreWorkspace(source.id) { self.start() }
    }
  }
  func askForSourceName(title: String, placeholder: String) -> String? {
    let alert = NSAlert()
    alert.messageText = title
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 26))
    field.placeholderString = placeholder
    alert.accessoryView = field
    alert.addButton(withTitle: "Cancel")
    alert.addButton(withTitle: "Continue")
    guard alert.runModal() == .alertSecondButtonReturn else { return nil }
    let value = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard value.range(of: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$", options: .regularExpression) != nil,
      !value.hasPrefix("ops_"), !value.hasPrefix("A3-")
    else { return nil }
    return value
  }
  @objc func addServiceAccount() {
    allowSourceChange { [weak self] in
      guard let self,
        let name = self.askForSourceName(
          title: "Name this service account", placeholder: "For example: work or staging")
      else { return }
      self.schemas = []
      self.discovery = ["auth": "service-account", "serviceAccountKeychain": name]
      self.start(configureServiceAccount: true)
    }
  }
  @objc func addDesktopAccount() {
    allowSourceChange { [weak self] in
      guard let self,
        let name = self.askForSourceName(
          title: "Choose a desktop account", placeholder: "1Password account UUID or name")
      else { return }
      self.schemas = []
      self.discovery = ["auth": "desktop", "account": name]
      self.start()
    }
  }

  func status(_ text: String) {
    let label = NSTextField(wrappingLabelWithString: text)
    label.alignment = .center
    label.frame = NSRect(x: 40, y: 320, width: 1100, height: 100)
    let view = NSView()
    view.addSubview(label)
    showContent(view)
  }

  func fail() {
    stop()
    status(
      "Unable to open Better Env Vault. Check 1Password authorization, then use Refresh to retry.")
    if connectionPath != nil {
      finishConnection(false)
    } else if verifying {
      finishVerification(false)
    }
  }

  func parkWorkspace() {
    guard !selectedSource.isEmpty, let view = web, let process = child,
      process.isRunning, let pipe = input, let url = origin
    else { return }
    if let previous = warm.removeValue(forKey: selectedSource) { dispose(previous) }
    warm[selectedSource] = WarmWorkspace(
      web: view, child: process, input: pipe, origin: url, generation: generation, parked: Date(),
      refreshed: refreshedAt)
    web = nil
    child = nil
    input = nil
    origin = nil
    // Keep a bounded number of RAM-only sessions; the source list has no limit.
    if warm.count > 4, let oldest = warm.min(by: { $0.value.parked < $1.value.parked }) {
      dispose(oldest.value)
      warm.removeValue(forKey: oldest.key)
    }
  }

  func restoreWorkspace(_ id: String) -> Bool {
    guard let workspace = warm.removeValue(forKey: id) else { return false }
    guard workspace.child.isRunning else {
      dispose(workspace)
      return false
    }
    web = workspace.web
    child = workspace.child
    input = workspace.input
    origin = workspace.origin
    generation = workspace.generation
    showContent(workspace.web)
    refreshedAt = workspace.refreshed
    if Date().timeIntervalSince(refreshedAt) > 30 { refresh() }
    if verifying { verifyUI(attempt: 0) }
    return true
  }

  func dispose(_ workspace: WarmWorkspace) {
    workspace.web.stopLoading()
    workspace.web.navigationDelegate = nil
    workspace.web.configuration.userContentController.removeAllUserScripts()
    workspace.input.fileHandleForWriting.closeFile()
    if workspace.child.isRunning { workspace.child.terminate() }
    let process = workspace.child
    DispatchQueue.global().async {
      let deadline = Date().addingTimeInterval(2)
      while process.isRunning && Date() < deadline { usleep(10_000) }
      if process.isRunning { kill(process.processIdentifier, SIGKILL) }
      process.waitUntilExit()
    }
  }

  func stop() {
    nextGeneration += 1
    generation = nextGeneration
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

  @objc func refresh() {
    guard let view = web else {
      start()
      return
    }
    refreshedAt = Date()
    view.evaluateJavaScript(
      "window.dispatchEvent(new Event('bev-refresh'))", completionHandler: nil)
  }
  @objc func browseVaults() {
    allowSourceChange { [weak self] in
      self?.schemas = []
      self?.start()
    }
  }
  @objc func openSchema() {
    let panel = NSOpenPanel()
    panel.showsHiddenFiles = true
    panel.allowsMultipleSelection = true
    panel.canChooseDirectories = false
    if panel.runModal() == .OK {
      let paths = panel.urls.map(\.path)
      allowSourceChange { [weak self] in
        guard let self else { return }
        if let previous = self.warm.removeValue(forKey: "schemas") { self.dispose(previous) }
        self.schemas = paths
        self.start()
      }
    }
  }

  @objc func configureServiceAccount() {
    allowSourceChange { [weak self] in
      guard let self else { return }
      self.schemas = []
      self.discovery["auth"] = "service-account"
      self.start(configureServiceAccount: true)
    }
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
    showContent(view)
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
    if configureServiceAccount, let cached = warm.removeValue(forKey: selectedSource) {
      dispose(cached)
    }
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
          "sourceNames": storedSourceNames(),
        ]
        : ["schemas": schemas, "sourceNames": storedSourceNames()]
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
          while data.count < 65536 {
            let byte = outgoing.fileHandleForReading.readData(ofLength: 1)
            if byte.isEmpty { return }
            if byte == Data([10]) { break }
            data.append(byte)
          }
          guard data.count < 65536,
            let record = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
          else { return }
          DispatchQueue.main.async {
            guard let self, self.generation == current else { return }
            self.updateSources(record)
            if record["sources"] != nil && record["url"] == nil && record["setupRequired"] == nil {
              return
            }
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
    refreshedAt = Date()
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
    view.underPageBackgroundColor = .windowBackgroundColor
    web = view
    showContent(view)
    view.load(URLRequest(url: url))
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    let url = navigationAction.request.url
    let expected =
      webView === web ? origin : warm.values.first(where: { $0.web === webView })?.origin
    let allowed =
      expected != nil && url?.scheme == expected?.scheme && url?.host == expected?.host
      && url?.port == expected?.port
    decisionHandler(allowed && navigationAction.targetFrame?.isMainFrame == true ? .allow : .cancel)
  }
  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) { if webView === web { fail() } }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    if webView === web {
      start()
    } else if let cached = warm.first(where: { $0.value.web === webView }) {
      dispose(cached.value)
      warm.removeValue(forKey: cached.key)
    }
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    // Bootstrap remains only in this document's memory, never in future scripts/history.
    webView.configuration.userContentController.removeAllUserScripts()
    if verifying && webView === web { verifyUI(attempt: 0) }
  }

  func verifyUI(attempt: Int) {
    guard verifying, !verified, let view = web else { return }
    let menuItems = sourceMenu.items.filter { $0.representedObject is String }
    guard !sources.isEmpty, menuItems.count == sources.count,
      menuItems.enumerated().allSatisfy({
        $0.element.keyEquivalent == ($0.offset < 9 ? String($0.offset + 1) : "")
      }),
      sourcePicker.selectedItem?.representedObject as? String == selectedSource
    else {
      verificationState = "SOURCE_SELECTOR_UNAVAILABLE"
      finishVerification(false)
      return
    }
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
        if let target = self.verificationSource, !self.verificationSwitched {
          guard let index = self.sources.firstIndex(where: { $0.id == target }) else {
            if attempt < 60 {
              DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                self.verifyUI(attempt: attempt + 1)
              }
            } else {
              self.verificationState = "SOURCE_SWITCH_FAILED"
              self.finishVerification(false)
            }
            return
          }
          guard target != self.selectedSource else {
            self.verificationState = "SOURCE_SWITCH_FAILED"
            self.finishVerification(false)
            return
          }
          self.verificationSwitched = true
          if index < 9 {
            let keys: [UInt16] = [18, 19, 20, 21, 23, 22, 26, 28, 25]
            guard
              let event = NSEvent.keyEvent(
                with: .keyDown, location: .zero, modifierFlags: [.command],
                timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: self.window.windowNumber, context: nil, characters: String(index + 1),
                charactersIgnoringModifiers: String(index + 1), isARepeat: false,
                keyCode: keys[index]),
              NSApplication.shared.mainMenu?.performKeyEquivalent(with: event) == true
            else {
              self.verificationState = "SOURCE_SWITCH_FAILED"
              self.finishVerification(false)
              return
            }
          } else {
            self.sourcePicker.selectItem(at: index)
            self.pickSource()
          }
          return
        }
        if let target = self.verificationSource, self.selectedSource != target {
          self.verificationState = "SOURCE_SWITCH_FAILED"
          self.finishVerification(false)
          return
        }
        if !self.warmVerified {
          guard let process = self.child, let origin = self.origin else {
            self.finishVerification(false)
            return
          }
          let source = self.selectedSource
          self.warmVerified = true
          let start = ProcessInfo.processInfo.systemUptime
          self.parkWorkspace()
          self.window.close()
          _ = self.applicationShouldHandleReopen(NSApplication.shared, hasVisibleWindows: false)
          guard self.restoreWorkspace(source), self.web === view,
            self.child === process, self.origin == origin, process.isRunning,
            ProcessInfo.processInfo.systemUptime - start < 0.5
          else {
            self.verificationState = "WARM_REUSE_FAILED"
            self.finishVerification(false)
            return
          }
          FileHandle.standardOutput.write(Data("WARM_WORKSPACE_REUSE_OK\n".utf8))
          return
        }
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
    if success && verificationSwitched {
      FileHandle.standardOutput.write(Data("SOURCE_SWITCHING_OK\n".utf8))
    }
    verificationSucceeded = success
    NSApplication.shared.terminate(nil)
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool
  {
    window.makeKeyAndOrderFront(nil)
    refresh()
    return true
  }
  func applicationWillTerminate(_ notification: Notification) {
    quitting = true
    // Signal all parked children before waiting, so Quit has one bounded deadline.
    let cached = Array(warm.values)
    warm.removeAll()
    for workspace in cached {
      workspace.input.fileHandleForWriting.closeFile()
      if workspace.child.isRunning { workspace.child.terminate() }
    }
    stop()
    let deadline = Date().addingTimeInterval(2)
    for workspace in cached {
      while workspace.child.isRunning && Date() < deadline { usleep(10_000) }
      if workspace.child.isRunning { kill(workspace.child.processIdentifier, SIGKILL) }
      workspace.child.waitUntilExit()
    }
    if connectionPath != nil { exit(connectionFailed ? 1 : 0) }
    if verifying { exit(verificationSucceeded ? 0 : 1) }
  }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
