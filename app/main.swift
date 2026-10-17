import Cocoa
import IOKit.pwr_mgt
import ServiceManagement
import Network

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let port = 8080
    let defaults = UserDefaults.standard
    var item: NSStatusItem!
    var proc: Process?
    var lastError = ""
    var assertion: IOPMAssertionID = 0
    var browser: NWBrowser?

    // The media folder lives in a file shared with the server, so changing it from the phone is reflected here.
    let configURL = URL(fileURLWithPath: NSHomeDirectory() + "/Library/Application Support/LocalTV/config.json")
    var folder: String {
        get {
            if let d = try? Data(contentsOf: configURL),
               let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let r = j["root"] as? String { return r }
            return defaults.string(forKey: "folder") ?? NSHomeDirectory() + "/Movies"
        }
        set {
            try? FileManager.default.createDirectory(at: configURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            var cfg = (try? Data(contentsOf: configURL)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            cfg["root"] = newValue
            if let d = try? JSONSerialization.data(withJSONObject: cfg) { try? d.write(to: configURL) }
        }
    }
    var folderItem: NSMenuItem?
    func menuNeedsUpdate(_ menu: NSMenu) {
        folderItem?.title = "Media folder: \((folder as NSString).abbreviatingWithTildeInPath)"
    }
    var keepAwake: Bool {
        get { defaults.object(forKey: "keepAwake") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "keepAwake") }
    }
    var running: Bool { proc?.isRunning ?? false }

    func applicationDidFinishLaunching(_ n: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        // One-time move from the app's old name (TVUtils) so existing settings and logs carry over.
        for base in ["Application Support", "Logs"] {
            let lib = NSHomeDirectory() + "/Library/" + base + "/"
            if FileManager.default.fileExists(atPath: lib + "TVUtils"), !FileManager.default.fileExists(atPath: lib + "LocalTV") {
                try? FileManager.default.moveItem(atPath: lib + "TVUtils", toPath: lib + "LocalTV")
            }
        }
        if !FileManager.default.fileExists(atPath: configURL.path), let old = defaults.string(forKey: "folder") { folder = old }
        // Browsing for cast devices from the app itself makes macOS show the Local Network prompt for LocalTV.
        browser = NWBrowser(for: .bonjour(type: "_googlecast._tcp", domain: nil), using: .tcp)
        browser?.browseResultsChangedHandler = { _, _ in }
        browser?.start(queue: .main)
        start()
    }
    func applicationWillTerminate(_ n: Notification) { stop() }

    // MARK: server control
    func findNode() -> String? {
        for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] where FileManager.default.isExecutableFile(atPath: p) { return p }
        let t = Process(); let pipe = Pipe()
        t.executableURL = URL(fileURLWithPath: "/bin/zsh"); t.arguments = ["-lc", "command -v node"]; t.standardOutput = pipe
        try? t.run(); t.waitUntilExit()
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return out.isEmpty ? nil : out
    }

    func start() {
        guard !running else { return }
        lastError = ""
        guard let node = findNode() else { lastError = "Node.js not found — install it from nodejs.org"; rebuild(); return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [Bundle.main.resourcePath! + "/server.js"]
        p.environment = ["PORT": String(port), "HOME": NSHomeDirectory(), "LOCALTV_PARENT": String(getpid())]
        let err = Pipe(); p.standardError = err; p.standardOutput = FileHandle.nullDevice
        err.fileHandleForReading.readabilityHandler = { [weak self] h in
            let s = String(data: h.availableData, encoding: .utf8) ?? ""
            if s.contains("EADDRINUSE") { DispatchQueue.main.async { self?.lastError = "Port \(self?.port ?? 0) is already in use" } }
        }
        p.terminationHandler = { [weak self] _ in DispatchQueue.main.async { self?.releaseAwake(); self?.rebuild() } }
        do { try p.run(); proc = p } catch { lastError = error.localizedDescription }
        if running && keepAwake { holdAwake() }
        rebuild()
    }

    func stop() {
        proc?.terminationHandler = nil
        proc?.terminate(); proc = nil
        releaseAwake(); rebuild()
    }

    func holdAwake() {
        guard assertion == 0 else { return }
        IOPMAssertionCreateWithName("PreventUserIdleSystemSleep" as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn),
                                    "LocalTV is streaming" as CFString, &assertion)
    }
    func releaseAwake() { if assertion != 0 { IOPMAssertionRelease(assertion); assertion = 0 } }

    // MARK: network
    func lanIP() -> String? {
        var ifa: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifa) == 0 else { return nil }
        defer { freeifaddrs(ifa) }
        var best: String?
        for p in sequence(first: ifa, next: { $0?.pointee.ifa_next }) {
            guard let i = p?.pointee, i.ifa_addr.pointee.sa_family == UInt8(AF_INET) else { continue }
            let name = String(cString: i.ifa_name)
            guard name.hasPrefix("en") else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            getnameinfo(i.ifa_addr, socklen_t(i.ifa_addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
            let ip = String(cString: host)
            if name == "en0" { return ip }
            best = best ?? ip
        }
        return best
    }
    var localName: String? {
        let t = Process(); let pipe = Pipe()
        t.executableURL = URL(fileURLWithPath: "/usr/sbin/scutil"); t.arguments = ["--get", "LocalHostName"]; t.standardOutput = pipe
        try? t.run(); t.waitUntilExit()
        let n = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return n.isEmpty ? nil : n + ".local"
    }
    var nameBase: String? { localName.map { "http://\($0):\(port)" } }
    var base: String { "http://\(lanIP() ?? "localhost"):\(port)" }

    // MARK: menu
    func rebuild() {
        item.button?.image = NSImage(systemSymbolName: running ? "tv.fill" : "tv", accessibilityDescription: "LocalTV")
        let m = NSMenu()
        func add(_ t: String, _ sel: Selector?, key: String = "", on: Bool = false, enabled: Bool = true) {
            let mi = NSMenuItem(title: t, action: sel, keyEquivalent: key)
            mi.target = self; mi.state = on ? .on : .off; mi.isEnabled = enabled && (sel != nil)
            m.addItem(mi)
        }
        add(running ? "● Server running" : "○ Server stopped", nil)
        if !lastError.isEmpty { add("⚠︎ " + lastError, nil) }
        m.addItem(.separator())
        if running {
            add("Show QR code for phone…", #selector(showQR))
            add("Phone remote: \(base)/", #selector(copyPhone))
            if let nb = nameBase { add("Bookmarkable: \(nb)/", #selector(copyName)) }
            add("TV browser page (fallback): \(base)/tv", #selector(copyTV))
            add("Open phone page in browser", #selector(openPhone))
            m.addItem(.separator())
            add("Stop server", #selector(stopAction))
        } else {
            add("Start server", #selector(startAction))
        }
        m.addItem(.separator())
        add("Media folder: \((folder as NSString).abbreviatingWithTildeInPath)", nil)
        folderItem = m.items.last
        add("Choose media folder…", #selector(chooseFolder))
        add("Keep Mac awake while running", #selector(toggleAwake), on: keepAwake)
        add("Launch at login", #selector(toggleLogin), on: SMAppService.mainApp.status == .enabled)
        m.addItem(.separator())
        add("Quit", #selector(quit), key: "q")
        m.delegate = self
        item.menu = m
    }

    func copy(_ s: String) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(s, forType: .string) }
    @objc func copyName() { if let nb = nameBase { copy(nb + "/") } }
    var qrWindow: NSWindow?
    @objc func showQR() {
        let url = base + "/"
        guard let f = CIFilter(name: "CIQRCodeGenerator") else { return }
        f.setValue(Data(url.utf8), forKey: "inputMessage"); f.setValue("M", forKey: "inputCorrectionLevel")
        guard let ci = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)) else { return }
        let rep = NSCIImageRep(ciImage: ci)
        let img = NSImage(size: rep.size); img.addRepresentation(rep)
        let side: CGFloat = 300
        let iv = NSImageView(frame: NSRect(x: 30, y: 90, width: side, height: side))
        iv.image = img; iv.imageScaling = .scaleProportionallyUpOrDown
        func label(_ t: String, y: CGFloat, size: CGFloat, color: NSColor) -> NSTextField {
            let l = NSTextField(labelWithString: t); l.font = .systemFont(ofSize: size); l.textColor = color
            l.alignment = .center; l.frame = NSRect(x: 10, y: y, width: side + 40, height: size + 8); return l
        }
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: side + 60, height: 440), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "LocalTV — open on your phone"
        w.contentView?.addSubview(iv)
        w.contentView?.addSubview(label("Scan with your phone camera", y: 400 - 8, size: 15, color: .labelColor))
        w.contentView?.addSubview(label(url, y: 62, size: 13, color: .secondaryLabelColor))
        if let nb = nameBase { w.contentView?.addSubview(label("Bookmark: \(nb)/", y: 36, size: 12, color: .tertiaryLabelColor)) }
        w.center(); w.isReleasedWhenClosed = false
        qrWindow?.close(); qrWindow = w
        NSApp.activate(ignoringOtherApps: true); w.makeKeyAndOrderFront(nil)
    }
    @objc func copyTV() { copy(base + "/tv") }
    @objc func copyPhone() { copy(base + "/") }
    @objc func openPhone() { NSWorkspace.shared.open(URL(string: base + "/")!) }
    @objc func startAction() { start() }
    @objc func stopAction() { stop() }
    @objc func quit() { NSApp.terminate(nil) }
    @objc func toggleAwake() {
        keepAwake.toggle()
        if running { keepAwake ? holdAwake() : releaseAwake() }
        rebuild()
    }
    @objc func toggleLogin() {
        do { if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() } }
        catch { lastError = "Launch at login: " + error.localizedDescription }
        rebuild()
    }
    @objc func chooseFolder() {
        NSApp.activate(ignoringOtherApps: true)
        let p = NSOpenPanel()
        p.canChooseFiles = false; p.canChooseDirectories = true; p.allowsMultipleSelection = false
        p.directoryURL = URL(fileURLWithPath: folder); p.prompt = "Use folder"
        if p.runModal() == .OK, let u = p.url {
            folder = u.path
            if running { stop(); start() } else { rebuild() }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
