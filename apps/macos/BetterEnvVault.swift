import AppKit
import Darwin
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
    window.makeKeyAndOrderFront(nil)
    NSApplication.shared.activate(ignoringOtherApps: true)
    start()
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
    if verifying { finishVerification(false) }
  }

  func stop() {
    generation += 1
    web?.stopLoading()
    web?.configuration.userContentController.removeAllUserScripts()
    web?.navigationDelegate = nil
    web = nil
    origin = nil
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

  func start() {
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
        ? ["schemas": [], "discovery": discovery]
        : ["schemas": schemas]
      let data = try JSONSerialization.data(withJSONObject: config)
      try process.run()
      child = process
      input = incoming
      incoming.fileHandleForWriting.write(data + Data([10]))
      DispatchQueue.global().async { [weak self] in
        // Read only the bounded startup record, never server diagnostics.
        var data = Data()
        while data.count < 1024 {
          let byte = outgoing.fileHandleForReading.readData(ofLength: 1)
          if byte.isEmpty || byte == Data([10]) { break }
          data.append(byte)
        }
        let record = (try? JSONSerialization.jsonObject(with: data)) as? [String: String]
        DispatchQueue.main.async {
          guard let self, self.generation == current else { return }
          guard let record, let address = record["url"], let url = URL(string: address),
            url.host == "127.0.0.1", url.scheme == "http", url.port != nil,
            let bootstrap = record["bootstrap"], bootstrap.count == 64,
            bootstrap.allSatisfy({ $0.isHexDigit })
          else {
            self.fail()
            return
          }
          self.load(url, bootstrap: bootstrap)
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
    if verifying { exit(verificationSucceeded ? 0 : 1) }
  }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
