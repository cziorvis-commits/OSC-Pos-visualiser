// OSC Visualiser: a menu bar app that runs the Node bridge in the background (no
// terminal) and shows the visualiser in a window that can go full screen.
// Closing the window leaves the app in the menu bar; Quit stops the bridge.
// Built by macos/build.sh, which bundles bridge/, public/ and config.json.
import Cocoa
import ServiceManagement
import WebKit

let appName = "OSC Visualiser"

// MARK: - Bridge process

final class Bridge {
  enum State: Equatable {
    case starting
    case running(external: Bool) // external: started elsewhere, e.g. the double-click launcher
    case stopped(String)
  }

  var state: State = .starting { didSet { onChange?() } }
  var onChange: (() -> Void)?
  var onReady: (() -> Void)?
  var onNodeMissing: (() -> Void)?

  let appDir = Bundle.main.resourceURL!.appendingPathComponent("app")
  let configURL: URL
  let logURL: URL
  private var process: Process?
  private var stdinPipe: Pipe?
  private var stopping = false

  init() {
    let fm = FileManager.default
    let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(appName)
    let logs = fm.urls(for: .libraryDirectory, in: .userDomainMask)[0].appendingPathComponent("Logs/\(appName)")
    try? fm.createDirectory(at: support, withIntermediateDirectories: true)
    try? fm.createDirectory(at: logs, withIntermediateDirectories: true)
    configURL = support.appendingPathComponent("config.json")
    logURL = logs.appendingPathComponent("bridge.log")
    // First run: start from the config.json the app was built with.
    if !fm.fileExists(atPath: configURL.path) {
      try? fm.copyItem(at: appDir.appendingPathComponent("config.json"), to: configURL)
    }
  }

  var httpPort: Int {
    let data = try? Data(contentsOf: configURL)
    let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    return json?["httpPort"] as? Int ?? 8181
  }

  var url: URL { URL(string: "http://localhost:\(httpPort)")! }

  func start() {
    state = .starting
    ping { up in
      if up {
        self.state = .running(external: true)
        self.onReady?()
      } else {
        self.spawn()
      }
    }
  }

  func stop() {
    stopping = true
    process?.terminate()
  }

  func restart() {
    guard let p = process else { return start() }
    stopping = true
    p.terminationHandler = nil
    p.terminate()
    DispatchQueue.global().async {
      p.waitUntilExit()
      DispatchQueue.main.async {
        self.process = nil
        self.stopping = false
        self.start()
      }
    }
  }

  private func ping(_ done: @escaping (Bool) -> Void) {
    var req = URLRequest(url: URL(string: "http://127.0.0.1:\(httpPort)/")!)
    req.timeoutInterval = 0.5
    URLSession.shared.dataTask(with: req) { _, res, _ in
      let up = (res as? HTTPURLResponse)?.statusCode == 200
      DispatchQueue.main.async { done(up) }
    }.resume()
  }

  // Apps opened from Finder don't get the shell's PATH, so look where Node usually lives.
  static func findNode() -> String? {
    let fm = FileManager.default
    let home = fm.homeDirectoryForCurrentUser.path
    var candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "\(home)/.volta/bin/node"]
    let nvm = "\(home)/.nvm/versions/node"
    if let versions = try? fm.contentsOfDirectory(atPath: nvm) {
      let newestFirst = versions.sorted { $0.compare($1, options: .numeric) == .orderedDescending }
      candidates += newestFirst.map { "\(nvm)/\($0)/bin/node" }
    }
    if let found = candidates.first(where: { fm.isExecutableFile(atPath: $0) }) { return found }
    // Last resort: ask a login shell.
    let shell = Process()
    shell.executableURL = URL(fileURLWithPath: "/bin/zsh")
    shell.arguments = ["-lc", "command -v node"]
    let out = Pipe()
    shell.standardOutput = out
    shell.standardError = FileHandle.nullDevice
    shell.standardInput = FileHandle.nullDevice
    guard (try? shell.run()) != nil else { return nil }
    shell.waitUntilExit()
    let path = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return fm.isExecutableFile(atPath: path) ? path : nil
  }

  private func spawn() {
    DispatchQueue.global().async {
      let node = Bridge.findNode()
      DispatchQueue.main.async {
        guard let node else {
          self.state = .stopped("Node.js not found")
          self.onNodeMissing?()
          return
        }
        self.launch(node)
      }
    }
  }

  private func launch(_ node: String) {
    FileManager.default.createFile(atPath: logURL.path, contents: nil)
    guard let log = try? FileHandle(forWritingTo: logURL) else {
      state = .stopped("Cannot write \(logURL.path)")
      return
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: node)
    p.arguments = [appDir.appendingPathComponent("bridge/server.js").path]
    p.currentDirectoryURL = appDir
    var env = ProcessInfo.processInfo.environment
    env["CONFIG"] = configURL.path
    env["EXIT_WITH_STDIN"] = "1"
    p.environment = env
    let pipe = Pipe()
    p.standardInput = pipe
    p.standardOutput = log
    p.standardError = log
    p.terminationHandler = { proc in
      DispatchQueue.main.async {
        self.process = nil
        if !self.stopping { self.state = .stopped("Bridge stopped (exit \(proc.terminationStatus)), see the log") }
      }
    }
    do {
      try p.run()
    } catch {
      state = .stopped("Cannot start Node: \(error.localizedDescription)")
      return
    }
    process = p
    stdinPipe = pipe
    waitUntilUp(tries: 40)
  }

  private func waitUntilUp(tries: Int) {
    ping { up in
      guard self.process != nil else { return }
      if up {
        self.state = .running(external: false)
        self.onReady?()
      } else if tries > 0 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitUntilUp(tries: tries - 1) }
      } else {
        self.state = .stopped("Bridge didn't start, see the log")
      }
    }
  }
}

// MARK: - Live input status, read from the bridge's WebSocket

final class StatusClient {
  struct Tracker {
    var x: Double, y: Double, z: Double
    var src: String
    var seen: Date
    let order: Int // first-seen order, for a stable colour
  }

  var status: [String: [String: Any]] = [:]
  var config: [String: Any] = [:]
  var trackers: [String: Tracker] = [:]
  var wantsPositions = false // only decode position batches while the mini view is showing
  var onUpdate: (() -> Void)?
  private var task: URLSessionWebSocketTask?
  private var port = 8181
  private var generation = 0

  func connect(port: Int) {
    self.port = port
    generation += 1
    task?.cancel()
    let gen = generation
    let t = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
    t.maximumMessageSize = 16 * 1024 * 1024
    task = t
    t.resume()
    receive(t, gen)
  }

  private func receive(_ t: URLSessionWebSocketTask, _ gen: Int) {
    t.receive { [weak self] result in
      DispatchQueue.main.async {
        guard let self, gen == self.generation else { return }
        switch result {
        case .failure:
          self.status = [:]
          self.onUpdate?()
          DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            if gen == self.generation { self.connect(port: self.port) }
          }
        case .success(let message):
          // Position batches arrive ~60 times a second: decode them only for the mini view.
          if case .string(let s) = message, s.hasPrefix("{\"type\":\"batch\"") {
            if self.wantsPositions { self.addBatch(s) }
          } else if case .string(let s) = message,
             let data = s.data(using: .utf8),
             let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if obj["type"] as? String == "inputs", let st = obj["status"] as? [String: [String: Any]] {
              self.status = st
              self.onUpdate?()
            } else if obj["type"] as? String == "config", let c = obj["config"] as? [String: Any] {
              self.config = c
              self.onUpdate?()
            }
          }
          self.receive(t, gen)
        }
      }
    }
  }

  private func addBatch(_ s: String) {
    guard let data = s.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let pos = obj["pos"] as? [[String: Any]] else { return }
    let now = Date()
    for p in pos {
      guard let id = p["id"] as? String, let x = p["x"] as? Double, let y = p["y"] as? Double else { continue }
      let order = trackers[id]?.order ?? trackers.count
      trackers[id] = Tracker(x: x, y: y, z: p["z"] as? Double ?? 0, src: p["src"] as? String ?? "", seen: now, order: order)
    }
  }

  var staleSeconds: Double { (config["staleMs"] as? Double ?? 1500) / 1000 }

  var inputsOn: [String: Bool] {
    let i = config["inputs"] as? [String: Bool] ?? [:]
    return ["osc": i["osc"] ?? true, "psn": i["psn"] ?? true]
  }

  func setInputs(_ inputs: [String: Bool]) {
    var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/inputs")!)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: inputs)
    URLSession.shared.dataTask(with: req).resume()
  }

  enum Look { case live, waiting, error, off }

  // Same wording as the pills in the web UI.
  func describe(_ kind: String) -> (name: String, detail: String, look: Look) {
    let name = kind.uppercased()
    var whereText = ""
    if kind == "osc", let p = config["oscPort"] as? Int { whereText = ":\(p)" }
    if kind == "psn", let psn = config["psn"] as? [String: Any], let g = psn["group"] as? String, let p = psn["port"] as? Int {
      whereText = "\(g):\(p)"
    }
    guard let s = status[kind] else { return (name, "\(whereText)  ·  bridge not connected", .waiting) }
    let hz = s["hz"] as? Int ?? 0
    let receiving = (s["ago"] as? Int).map { $0 < 2000 } ?? false
    let from = s["from"] as? String
    if let err = s["error"] as? String { return (name, "\(whereText)  ·  error: \(err)", .error) }
    if !(inputsOn[kind] ?? true) {
      return (name, receiving ? "\(whereText)  ·  off, \(hz) Hz available" : "\(whereText)  ·  off", .off)
    }
    if receiving { return (name, "\(whereText)  ·  \(hz) Hz from \(from ?? "?")", .live) }
    return (name, "\(whereText)  ·  no data", .waiting)
  }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate {
  let bridge = Bridge()
  let status = StatusClient()
  var statusItem: NSStatusItem!
  var window: NSWindow?
  var webView: WKWebView?
  var inputItems: [String: NSMenuItem] = [:]
  var shownAtLaunch = false
  lazy var miniView = MiniView(status: status) { [weak self] in self?.showWindow() }
  lazy var miniItem: NSMenuItem = {
    let item = NSMenuItem()
    item.view = miniView
    return item
  }()
  var miniTimer: Timer?

  // Opened at login: stay quietly in the menu bar instead of opening the window.
  func applicationWillFinishLaunching(_ note: Notification) {
    let event = NSAppleEventManager.shared().currentAppleEvent
    if event?.eventID == kAEOpenApplication,
       event?.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem {
      shownAtLaunch = true
    }
  }

  func applicationDidFinishLaunching(_ note: Notification) {
    NSApp.setActivationPolicy(.accessory)
    buildMainMenu()

    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    menu.delegate = self
    statusItem.menu = menu
    updateIcon()

    bridge.onChange = { [weak self] in
      self?.updateIcon()
      self?.showBridgeStateInWindow()
    }
    bridge.onReady = { [weak self] in
      guard let self else { return }
      self.status.connect(port: self.bridge.httpPort)
      self.webView?.load(URLRequest(url: self.bridge.url))
      if !self.shownAtLaunch {
        self.shownAtLaunch = true
        self.showWindow()
      }
    }
    bridge.onNodeMissing = { [weak self] in self?.alertNodeMissing() }
    status.onUpdate = { [weak self] in
      self?.updateIcon()
      self?.refreshInputItems()
    }
    bridge.start()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  // Opening the app again (Finder, Spotlight) brings the window back.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    showWindow()
    return true
  }

  func applicationWillTerminate(_ note: Notification) {
    bridge.stop()
  }

  // MARK: Menu bar icon and menu

  func updateIcon() {
    guard let button = statusItem?.button else { return }
    let running: Bool
    if case .running = bridge.state { running = true } else { running = false }
    let anyLive = ["osc", "psn"].contains { status.describe($0).look == .live }
    let symbol = running ? "dot.radiowaves.left.and.right" : "exclamationmark.triangle"
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: appName)
    image?.isTemplate = true
    button.image = image
    button.appearsDisabled = running && !anyLive // dimmed while no tracking data arrives
    switch bridge.state {
    case .starting: button.toolTip = "\(appName): starting"
    case .running: button.toolTip = anyLive ? "\(appName): receiving" : "\(appName): waiting for data"
    case .stopped(let why): button.toolTip = "\(appName): \(why)"
    }
  }

  func menuWillOpen(_ menu: NSMenu) {
    status.wantsPositions = true
    // .common so it keeps firing while the menu is tracking the mouse.
    let timer = Timer(timeInterval: 1.0 / 15, repeats: true) { [weak self] _ in self?.miniView.needsDisplay = true }
    RunLoop.main.add(timer, forMode: .common)
    miniTimer = timer
  }

  func menuDidClose(_ menu: NSMenu) {
    status.wantsPositions = false
    miniTimer?.invalidate()
    miniTimer = nil
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    inputItems = [:]
    menu.addItem(miniItem)
    menu.addItem(.separator())

    let header: String
    switch bridge.state {
    case .starting: header = "Bridge starting…"
    case .running(let external): header = external ? "Bridge running (started outside the app)" : "Bridge running"
    case .stopped(let why): header = why
    }
    let headerItem = NSMenuItem(title: header, action: nil, keyEquivalent: "")
    headerItem.isEnabled = false
    menu.addItem(headerItem)

    menu.addItem(.separator())
    let inputsHeader = NSMenuItem(title: "Inputs (click to switch on or off)", action: nil, keyEquivalent: "")
    inputsHeader.isEnabled = false
    menu.addItem(inputsHeader)
    for kind in ["osc", "psn"] {
      let item = NSMenuItem(title: kind.uppercased(), action: #selector(toggleInput(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = kind
      menu.addItem(item)
      inputItems[kind] = item
    }
    refreshInputItems()

    menu.addItem(.separator())
    add(menu, "Show Visualiser", #selector(showWindowAction), "1")
    let fullScreen = window?.styleMask.contains(.fullScreen) == true
    let fs = add(menu, fullScreen ? "Exit Full Screen" : "Show Full Screen", #selector(toggleFullScreenAction), "f")
    fs.keyEquivalentModifierMask = [.control, .command]
    add(menu, "Open in Browser", #selector(openInBrowser), "")
    let ips = lanAddresses()
    if !ips.isEmpty {
      add(menu, "Copy Link for Other Devices (\(ips[0]):\(bridge.httpPort))", #selector(copyLanLink), "")
    }

    menu.addItem(.separator())
    add(menu, "Show config.json in Finder", #selector(revealConfig), "")
    add(menu, "Show Bridge Log", #selector(showLog), "")
    let restart = add(menu, "Restart Bridge", #selector(restartBridge), "")
    if case .running(external: true) = bridge.state { restart.isEnabled = false }

    menu.addItem(.separator())
    let login = add(menu, "Open at Login", #selector(toggleOpenAtLogin), "")
    switch SMAppService.mainApp.status {
    case .enabled: login.state = .on
    case .requiresApproval:
      login.state = .mixed
      login.title = "Open at Login (allow it in System Settings)"
    default: login.state = .off
    }
    add(menu, "Quit \(appName)", #selector(NSApplication.terminate(_:)), "q", target: NSApp)
  }

  @discardableResult
  func add(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String, target: AnyObject? = nil) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
    item.target = target ?? self
    menu.addItem(item)
    return item
  }

  // Updated live, also while the menu is open.
  func refreshInputItems() {
    let on = status.inputsOn
    for (kind, item) in inputItems {
      let d = status.describe(kind)
      let title = NSMutableAttributedString(string: d.name, attributes: [.font: NSFont.menuFont(ofSize: 0).bold()])
      title.append(NSAttributedString(string: "   \(d.detail)", attributes: [
        .font: NSFont.monospacedDigitSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular),
        .foregroundColor: NSColor.secondaryLabelColor,
      ]))
      item.attributedTitle = title
      item.image = dot(d.look)
      item.state = (on[kind] ?? true) ? .on : .off
      // At least one input stays on, and switching needs a connected bridge.
      let other = kind == "osc" ? "psn" : "osc"
      item.isEnabled = !status.status.isEmpty && !((on[kind] ?? true) && !(on[other] ?? true))
    }
  }

  func dot(_ look: StatusClient.Look) -> NSImage {
    let color: NSColor = switch look {
    case .live: .systemGreen
    case .waiting: .systemYellow
    case .error: .systemRed
    case .off: .tertiaryLabelColor
    }
    return NSImage(size: NSSize(width: 10, height: 10), flipped: false) { rect in
      let path = NSBezierPath(ovalIn: rect.insetBy(dx: 1, dy: 1))
      if look == .off {
        color.setStroke()
        path.lineWidth = 1.2
        path.stroke()
      } else {
        color.setFill()
        path.fill()
      }
      return true
    }
  }

  @objc func toggleInput(_ sender: NSMenuItem) {
    guard let kind = sender.representedObject as? String else { return }
    var next = status.inputsOn
    next[kind] = !(next[kind] ?? true)
    status.setInputs(next)
  }

  // MARK: Window

  @objc func showWindowAction() { showWindow() }

  func showWindow() {
    if window == nil { makeWindow() }
    NSApp.setActivationPolicy(.regular) // Dock icon and menus while the window is open
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  @objc func toggleFullScreenAction() {
    showWindow()
    DispatchQueue.main.async { self.window?.toggleFullScreen(nil) }
  }

  func makeWindow() {
    let config = WKWebViewConfiguration()
    let web = WKWebView(frame: .zero, configuration: config)
    if #available(macOS 13.3, *) { web.isInspectable = true }
    let win = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    win.title = "OSC Position Visualiser"
    win.contentView = web
    win.collectionBehavior = [.fullScreenPrimary]
    win.isReleasedWhenClosed = false
    win.delegate = self
    win.backgroundColor = NSColor(red: 0.055, green: 0.067, blue: 0.086, alpha: 1)
    win.center()
    win.setFrameAutosaveName("Visualiser")
    window = win
    webView = web
    if case .running = bridge.state {
      web.load(URLRequest(url: bridge.url))
    } else {
      showBridgeStateInWindow()
    }
  }

  func showBridgeStateInWindow() {
    guard let web = webView else { return }
    let text: String
    switch bridge.state {
    case .running: return
    case .starting: text = "Starting the bridge…"
    case .stopped(let why): text = why
    }
    let html = """
      <body style="margin:0;height:100vh;display:grid;place-items:center;background:#0e1116;color:#8a94a6;
        font:15px system-ui">\(text.replacingOccurrences(of: "<", with: "&lt;"))</body>
      """
    web.loadHTMLString(html, baseURL: nil)
  }

  func windowWillClose(_ note: Notification) {
    // Back to living in the menu bar only.
    NSApp.setActivationPolicy(.accessory)
  }

  // MARK: Other menu actions

  @objc func openInBrowser() { NSWorkspace.shared.open(bridge.url) }

  @objc func copyLanLink() {
    guard let ip = lanAddresses().first else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString("http://\(ip):\(bridge.httpPort)", forType: .string)
  }

  @objc func revealConfig() { NSWorkspace.shared.activateFileViewerSelecting([bridge.configURL]) }

  @objc func showLog() { NSWorkspace.shared.open(bridge.logURL) }

  @objc func restartBridge() { bridge.restart() }

  @objc func toggleOpenAtLogin() {
    let service = SMAppService.mainApp
    do {
      if service.status == .enabled || service.status == .requiresApproval {
        try service.unregister()
      } else {
        try service.register()
        // macOS may want the user to switch it on under Login Items first.
        if service.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
      }
    } catch {
      let alert = NSAlert()
      alert.messageText = "Couldn't change Open at Login"
      alert.informativeText = "\(error.localizedDescription)\n\nYou can add OSC Visualiser under System Settings › General › Login Items."
      NSApp.activate(ignoringOtherApps: true)
      alert.runModal()
    }
  }

  @objc func reloadPage() {
    if case .running = bridge.state { webView?.load(URLRequest(url: bridge.url)) }
  }

  func alertNodeMissing() {
    let alert = NSAlert()
    alert.messageText = "Node.js is needed"
    alert.informativeText = "OSC Visualiser runs its bridge with Node.js. Install the LTS version from nodejs.org, then choose Restart Bridge from the menu bar icon."
    alert.addButton(withTitle: "Open nodejs.org")
    alert.addButton(withTitle: "Cancel")
    NSApp.activate(ignoringOtherApps: true)
    if alert.runModal() == .alertFirstButtonReturn {
      NSWorkspace.shared.open(URL(string: "https://nodejs.org")!)
    }
  }

  func lanAddresses() -> [String] {
    var out: [String] = []
    var ifaddr: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return out }
    defer { freeifaddrs(ifaddr) }
    for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
      let flags = Int32(ptr.pointee.ifa_flags)
      guard let addr = ptr.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET),
            flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else { continue }
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      if getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
        let ip = String(cString: host)
        if !ip.hasPrefix("169.254.") { out.append(ip) }
      }
    }
    return out
  }

  // Shown while the window is open (the app is a regular app then): gives the
  // window the usual shortcuts, including copy/paste in the Floor panel fields.
  func buildMainMenu() {
    let main = NSMenu()
    func submenu(_ title: String, _ items: [NSMenuItem]) {
      let holder = NSMenuItem()
      let m = NSMenu(title: title)
      items.forEach(m.addItem)
      holder.submenu = m
      main.addItem(holder)
    }
    func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
      i.keyEquivalentModifierMask = mods
      return i
    }
    submenu(appName, [
      item("About \(appName)", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
      .separator(),
      item("Hide \(appName)", #selector(NSApplication.hide(_:)), "h"),
      .separator(),
      item("Quit \(appName)", #selector(NSApplication.terminate(_:)), "q"),
    ])
    submenu("Edit", [
      item("Undo", Selector(("undo:")), "z"),
      item("Redo", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("Cut", #selector(NSText.cut(_:)), "x"),
      item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Paste", #selector(NSText.paste(_:)), "v"),
      item("Select All", #selector(NSText.selectAll(_:)), "a"),
    ])
    let reload = item("Reload", #selector(reloadPage), "r")
    reload.target = self
    submenu("View", [
      item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.control, .command]),
      reload,
    ])
    submenu("Window", [
      item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Close", #selector(NSWindow.performClose(_:)), "w"),
    ])
    NSApp.mainMenu = main
  }
}

// MARK: - Mini view: a top-down plan for a quick check from the menu bar

final class MiniView: NSView {
  // Same colours as the 3D view (scene.js PALETTE).
  static let palette: [NSColor] = ([
    0x58a6ff, 0xf778ba, 0x3fb950, 0xd29922, 0xa371f7, 0xff7b72,
    0x39c5cf, 0xe3b341, 0x8ddb8c, 0xffa657, 0xbc8cff, 0x79c0ff,
  ] as [Int]).map(rgb)

  static func rgb(_ hex: Int) -> NSColor {
    let r = CGFloat((hex >> 16) & 0xff) / 255
    let g = CGFloat((hex >> 8) & 0xff) / 255
    let b = CGFloat(hex & 0xff) / 255
    return NSColor(red: r, green: g, blue: b, alpha: 1)
  }

  let status: StatusClient
  let onClick: () -> Void

  init(status: StatusClient, onClick: @escaping () -> Void) {
    self.status = status
    self.onClick = onClick
    super.init(frame: NSRect(x: 0, y: 0, width: 340, height: 250))
  }

  required init?(coder: NSCoder) { fatalError() }

  override func mouseUp(with event: NSEvent) {
    enclosingMenuItem?.menu?.cancelTracking()
    onClick()
  }

  // The floor's corners in tracking coordinates, from the stage block of config.json.
  func floorCorners() -> [CGPoint] {
    let stage = status.config["stage"] as? [String: Any] ?? [:]
    let w = stage["width"] as? Double ?? 3.66
    let d = stage["depth"] as? Double ?? 3.66
    let y0 = (stage["origin"] as? String) == "centre" ? -d / 2 : 0
    let pos = stage["position"] as? [Double] ?? [0, 0]
    let rot = (stage["rotation"] as? Double ?? 0) * .pi / 180
    return [(-w / 2, y0), (w / 2, y0), (w / 2, y0 + d), (-w / 2, y0 + d)].map { lx, ly in
      CGPoint(x: pos[0] + lx * cos(rot) - ly * sin(rot), y: pos[1] + lx * sin(rot) + ly * cos(rot))
    }
  }

  override func draw(_ dirtyRect: NSRect) {
    let panel = bounds.insetBy(dx: 12, dy: 6)
    let bg = NSBezierPath(roundedRect: panel, xRadius: 8, yRadius: 8)
    NSColor(red: 0.055, green: 0.067, blue: 0.086, alpha: 1).setFill()
    bg.fill()

    let now = Date()
    let names = status.config["names"] as? [String: String] ?? [:]
    let trackers = status.trackers.sorted { $0.value.order < $1.value.order }
    let live = trackers.filter { now.timeIntervalSince($0.value.seen) <= status.staleSeconds }

    // Fit the floor and every tracker (stale ones too) into the plan, keeping metres square.
    let plan = NSRect(x: panel.minX + 10, y: panel.minY + 24, width: panel.width - 20, height: panel.height - 34)
    let corners = floorCorners()
    let pts = corners + trackers.map { CGPoint(x: $0.value.x, y: $0.value.y) }
    let minX = pts.map(\.x).min()! - 0.4, maxX = pts.map(\.x).max()! + 0.4
    let minY = pts.map(\.y).min()! - 0.4, maxY = pts.map(\.y).max()! + 0.4
    let scale = min(plan.width / (maxX - minX), plan.height / (maxY - minY))
    let midX = (minX + maxX) / 2, midY = (minY + maxY) / 2
    func toView(_ x: Double, _ y: Double) -> CGPoint {
      CGPoint(x: plan.midX + (x - midX) * scale, y: plan.midY + (y - midY) * scale) // upstage is up
    }

    NSGraphicsContext.saveGraphicsState()
    NSBezierPath(rect: plan).addClip()

    // 1 m grid across the whole plan; skipped when zoomed out so far that it would be a blur.
    if scale >= 6 {
      let gx0 = midX - plan.width / 2 / scale, gx1 = midX + plan.width / 2 / scale
      let gy0 = midY - plan.height / 2 / scale, gy1 = midY + plan.height / 2 / scale
      let grid = NSBezierPath()
      for gx in Int(floor(gx0))...Int(ceil(gx1)) {
        grid.move(to: toView(Double(gx), gy0)); grid.line(to: toView(Double(gx), gy1))
      }
      for gy in Int(floor(gy0))...Int(ceil(gy1)) {
        grid.move(to: toView(gx0, Double(gy))); grid.line(to: toView(gx1, Double(gy)))
      }
      NSColor.white.withAlphaComponent(0.06).setStroke()
      grid.lineWidth = 1
      grid.stroke()
    }

    // Floor, with its downstage edge drawn brighter so the plan reads at a glance.
    let floorPath = NSBezierPath()
    floorPath.move(to: toView(corners[0].x, corners[0].y))
    corners.dropFirst().forEach { floorPath.line(to: toView($0.x, $0.y)) }
    floorPath.close()
    NSColor(red: 0.35, green: 0.65, blue: 1, alpha: 0.08).setFill()
    floorPath.fill()
    NSColor.white.withAlphaComponent(0.25).setStroke()
    floorPath.lineWidth = 1
    floorPath.stroke()
    let ds = NSBezierPath()
    ds.move(to: toView(corners[0].x, corners[0].y))
    ds.line(to: toView(corners[1].x, corners[1].y))
    NSColor.white.withAlphaComponent(0.6).setStroke()
    ds.lineWidth = 2
    ds.stroke()

    // Tracking origin
    let o = toView(0, 0)
    let cross = NSBezierPath()
    cross.move(to: CGPoint(x: o.x - 4, y: o.y)); cross.line(to: CGPoint(x: o.x + 4, y: o.y))
    cross.move(to: CGPoint(x: o.x, y: o.y - 4)); cross.line(to: CGPoint(x: o.x, y: o.y + 4))
    NSColor.white.withAlphaComponent(0.35).setStroke()
    cross.stroke()

    // Trackers: stale ones first, so live ones draw on top.
    let labelFont = NSFont.systemFont(ofSize: 9, weight: .semibold)
    var dots: [(id: String, p: CGPoint, r: CGFloat, live: Bool)] = []
    let ordered = trackers.sorted { a, b in
      (now.timeIntervalSince(a.value.seen) <= status.staleSeconds ? 1 : 0) < (now.timeIntervalSince(b.value.seen) <= status.staleSeconds ? 1 : 0)
    }
    for (id, t) in ordered {
      let isLive = now.timeIntervalSince(t.seen) <= status.staleSeconds
      let color = isLive ? MiniView.palette[t.order % MiniView.palette.count] : NSColor(white: 0.36, alpha: 1)
      let p = toView(t.x, t.y)
      let r: CGFloat = t.z > 0.3 ? 5.5 : 4.5 // a little bigger when lifted off the floor
      color.setFill()
      NSBezierPath(ovalIn: NSRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)).fill()
      dots.append((id, p, r, isLive))
    }

    // Labels: live ones get first pick. Each goes right of its dot, else left, and is
    // left out rather than drawn over another label (trackers parked on the same spot).
    var taken: [NSRect] = []
    for dot in dots.reversed() {
      let label = (names[dot.id] ?? dot.id) as NSString
      let attrs: [NSAttributedString.Key: Any] = [
        .font: labelFont,
        .foregroundColor: dot.live ? NSColor.white.withAlphaComponent(0.85) : NSColor(white: 0.45, alpha: 1),
      ]
      let size = label.size(withAttributes: attrs)
      let right = NSRect(x: dot.p.x + dot.r + 3, y: dot.p.y - size.height / 2, width: size.width, height: size.height)
      let left = right.offsetBy(dx: -(size.width + dot.r * 2 + 6), dy: 0)
      let fits = { (rect: NSRect) in plan.contains(rect) && !taken.contains { $0.insetBy(dx: -2, dy: -1).intersects(rect) } }
      guard let spot = [right, left].first(where: fits) else { continue }
      taken.append(spot)
      label.draw(at: spot.origin, withAttributes: attrs)
    }
    NSGraphicsContext.restoreGraphicsState()

    // Footer
    let footer: String
    if status.status.isEmpty {
      footer = "Bridge not connected"
    } else if trackers.isEmpty {
      footer = "No trackers yet"
    } else {
      footer = "\(live.count) live / \(trackers.count) trackers · upstage at top"
    }
    let small = NSFont.systemFont(ofSize: 10)
    (footer as NSString).draw(at: CGPoint(x: panel.minX + 10, y: panel.minY + 7), withAttributes: [
      .font: small, .foregroundColor: NSColor(white: 0.6, alpha: 1),
    ])
    let hint = "Click for full view" as NSString
    let hintAttrs: [NSAttributedString.Key: Any] = [.font: small, .foregroundColor: NSColor(red: 0.35, green: 0.65, blue: 1, alpha: 1)]
    hint.draw(at: CGPoint(x: panel.maxX - 10 - hint.size(withAttributes: hintAttrs).width, y: panel.minY + 7), withAttributes: hintAttrs)
  }
}

extension NSFont {
  func bold() -> NSFont { NSFontManager.shared.convert(self, toHaveTrait: .boldFontMask) }
}

// Developer aid: `"OSC Visualiser" --render-mini out.png` draws the menu's mini view
// from the running bridge into a PNG, since a menu can't be screenshotted on cue.
if let i = CommandLine.arguments.firstIndex(of: "--render-mini"), i + 1 < CommandLine.arguments.count {
  let out = URL(fileURLWithPath: CommandLine.arguments[i + 1])
  let status = StatusClient()
  status.wantsPositions = true
  status.connect(port: Bridge().httpPort)
  DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
    let view = MiniView(status: status) {}
    let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
    view.cacheDisplay(in: view.bounds, to: rep)
    try? rep.representation(using: .png, properties: [:])?.write(to: out)
    print("\(status.trackers.count) trackers -> \(out.path)")
    exit(0)
  }
  RunLoop.main.run()
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
