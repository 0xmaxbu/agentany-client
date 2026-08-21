// AX 引用仓库（移植 pi-computer-use native/macos/bridge.swift，MIT）：observe 吐出的 e#/w# 与元素互查，
// act 的 {ref} 语义据此定位。元素去重用 CFEqual（同一 AX 元素多次 observe 返回同一 ref，act 不失效）。
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

final class AXRefStore {
  struct NodeInfo {
    let role: String
    let title: String
    let desc: String
  }

  private let lock = NSLock()
  private var windows: [String: AXUIElement] = [:] // "w#"
  private var elements: [String: AXUIElement] = [:] // "e#"
  private var info: [String: NodeInfo] = [:]
  private var seq: UInt64 = 0

  func windowRef(_ el: AXUIElement) -> String {
    lock.lock(); defer { lock.unlock() }
    for (ref, existing) in windows where CFEqual(existing, el) { return ref }
    seq += 1
    let ref = "w\(seq)"
    windows[ref] = el
    return ref
  }

  func elementRef(_ el: AXUIElement, info: NodeInfo? = nil) -> String {
    lock.lock(); defer { lock.unlock() }
    for (ref, existing) in elements where CFEqual(existing, el) { return ref }
    seq += 1
    let ref = "e\(seq)"
    elements[ref] = el
    if let info { self.info[ref] = info }
    return ref
  }

  func window(_ ref: String) -> AXUIElement? { lock.lock(); defer { lock.unlock() }; return windows[ref] }
  func element(_ ref: String) -> AXUIElement? { lock.lock(); defer { lock.unlock() }; return elements[ref] }
  func info(_ ref: String) -> NodeInfo? { lock.lock(); defer { lock.unlock() }; return info[ref] }
}

// CG 窗口 → AX 窗口元素（屏幕录制权出 CG 列表；AX 账作 ref/语义目标）。
// macOS 无公开 AX→CG 窗口号属性（"AXWindowNumber" 实测 -25205 不可用）——
// 改按（pid + title + bounds）匹配：AX 与 CG 同在左上原点**点**空间，同窗口 bounds 必然重合。
func axWindow(pid: Int32, title: String, bounds: CGRect) -> AXUIElement? {
  let app = AXUIElementCreateApplication(pid)
  var windowsRef: CFTypeRef?
  guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsRef) == .success,
        let wins = windowsRef as? [AXUIElement] else { return nil }
  var titleMatch: AXUIElement?
  for w in wins {
    let r = axRectOf(w)
    let sameBounds = !r.isNull && abs(r.origin.x - bounds.origin.x) < 1.0 && abs(r.origin.y - bounds.origin.y) < 1.0
      && abs(r.width - bounds.width) < 1.0 && abs(r.height - bounds.height) < 1.0
    if sameBounds {
      let t = axString(w, kAXTitleAttribute as CFString) ?? ""
      if title.isEmpty || t == title { return w }
      titleMatch = w
    }
  }
  return titleMatch
}

// —— AX 属性小工具（容错：任一失败即默认值） ——
func axCopy(_ el: AXUIElement, _ attr: CFString) -> CFTypeRef? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(el, attr, &v) == .success ? v : nil
}

func axInt64(_ el: AXUIElement, _ attr: CFString) -> Int64? {
  switch axCopy(el, attr) {
  case let n as NSNumber: return n.int64Value
  case let s as String: return Int64(s)
  default: return nil
  }
}

func axString(_ el: AXUIElement, _ attr: CFString) -> String? {
  axCopy(el, attr) as? String
}

func axBool(_ el: AXUIElement, _ attr: CFString) -> Bool {
  (axCopy(el, attr) as? NSNumber)?.boolValue ?? false
}

func axPoint(_ el: AXUIElement, _ attr: CFString) -> CGPoint? {
  guard let v = axCopy(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  var p = CGPoint.zero
  return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}

func axSize(_ el: AXUIElement, _ attr: CFString) -> CGSize? {
  guard let v = axCopy(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  var s = CGSize.zero
  return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}

func axRectOf(_ el: AXUIElement) -> CGRect {
  var rect = CGRect.null
  if let p = axPoint(el, kAXPositionAttribute as CFString) {
    rect.origin = p
  }
  if let s = axSize(el, kAXSizeAttribute as CFString) {
    rect.size = s
  }
  return rect
}

func axPid(_ el: AXUIElement) -> Int32 {
  var pid: pid_t = 0
  AXUIElementGetPid(el, &pid)
  return pid
}

/// 前台应用 AX（系统级 focused application）。
/// SystemWide 焦点读取在部分环境 -25204（cannotComplete）——回退 NSWorkspace 前台应用按 pid 建账。
func frontmostAppElement() -> AXUIElement? {
  let sys = AXUIElementCreateSystemWide()
  if let v = axCopy(sys, kAXFocusedApplicationAttribute as CFString) { return (v as! AXUIElement) }
  if let app = NSWorkspace.shared.frontmostApplication {
    return AXUIElementCreateApplication(app.processIdentifier)
  }
  return nil
}