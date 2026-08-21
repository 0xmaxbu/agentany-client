// act 原子动作（移植 pi-computer-use native/macos/bridge.swift，MIT）：CGEvent 物理投递。
// 目标二选一：{x,y}（image px，按 pt 换算 CGEvent 点）或 {ref}（AX 语义，按元素中心）。
// 语义优先（ref/AX）→ 坐标兜底（像素）；每次 act 后由调用方回后置截图。
import ApplicationServices
import CoreGraphics
import Foundation

enum ActionError: Error { case invalid(String); case failed(String) }

private func post(_ event: CGEvent) {
  event.post(tap: .cghidEventTap)
}

private func mouseEvent(_ type: CGEventType, at point: CGPoint, button: CGMouseButton) -> CGEvent? {
  CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button)
}

func postMouseMove(to point: CGPoint) {
  if let e = mouseEvent(.mouseMoved, at: point, button: .left) { post(e) }
  usleep(12_000)
}

private func mouseDownType(_ b: CGMouseButton) -> CGEventType { b == .right ? .rightMouseDown : b == .center ? .otherMouseDown : .leftMouseDown }
private func mouseUpType(_ b: CGMouseButton) -> CGEventType { b == .right ? .rightMouseUp : b == .center ? .otherMouseUp : .leftMouseUp }
private func mouseDraggedType(_ b: CGMouseButton) -> CGEventType { b == .right ? .rightMouseDragged : b == .center ? .otherMouseDragged : .leftMouseDragged }

private func postClick(at point: CGPoint, button: CGMouseButton, clickCount: Int) throws {
  postMouseMove(to: point)
  for index in 1...max(1, clickCount) {
    guard let down = mouseEvent(mouseDownType(button), at: point, button: button),
          let up = mouseEvent(mouseUpType(button), at: point, button: button) else {
      throw ActionError.failed("failed to create click event")
    }
    down.setIntegerValueField(.mouseEventClickState, value: Int64(index))
    up.setIntegerValueField(.mouseEventClickState, value: Int64(index))
    post(down)
    usleep(12_000)
    post(up)
    if index < clickCount { usleep(70_000) }
  }
}

private func postDrag(from start: CGPoint, to end: CGPoint) throws {
  postMouseMove(to: start)
  guard let down = mouseEvent(.leftMouseDown, at: start, button: .left) else { throw ActionError.failed("drag: down") }
  post(down)
  usleep(12_000)
  let steps = 20
  for i in 1...steps {
    let t = CGFloat(i) / CGFloat(steps)
    let p = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
    if let drag = mouseEvent(mouseDraggedType(.left), at: p, button: .left) { post(drag) }
    usleep(8_000)
  }
  guard let up = mouseEvent(.leftMouseUp, at: end, button: .left) else { throw ActionError.failed("drag: up") }
  post(up)
}

private func postScroll(at point: CGPoint, dx: Int, dy: Int) {
  if let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                     wheel1: Int32(-dy), wheel2: Int32(dx), wheel3: 0) {
    e.location = point
    post(e)
  }
}

// —— 键盘 ——
private func modifierFlag(_ key: String) -> CGEventFlags? {
  switch key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "cmd", "command", "meta": return .maskCommand
  case "ctrl", "control": return .maskControl
  case "shift": return .maskShift
  case "option", "alt": return .maskAlternate
  default: return nil
  }
}

private func keyCode(_ key: String) -> CGKeyCode? {
  let k = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  let table: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
    "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
    "6": 22, "5": 23, "=": 24, "+": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
    "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36, "enter": 36,
    "l": 37, "j": 38, "'": 39, "\"": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
    "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, " ": 49, "`": 50, "~": 50,
    "backspace": 51, "delete": 51, "del": 51, "esc": 53, "escape": 53,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "home": 115, "pageup": 116, "page_up": 116, "pagedown": 121, "page_down": 121,
    "forwarddelete": 117, "forward_delete": 117, "end": 119,
    "left": 123, "arrow_left": 123, "right": 124, "arrow_right": 124,
    "down": 125, "arrow_down": 125, "up": 126, "arrow_up": 126,
  ]
  return table[k]
}

private func setUnicode(_ event: CGEvent, text: String) {
  var utf16 = Array(text.utf16)
  utf16.withUnsafeMutableBufferPointer { ptr in
    guard let base = ptr.baseAddress else { return }
    event.keyboardSetUnicodeString(stringLength: ptr.count, unicodeString: base)
  }
}

/// 物理击键首选（US 布局）；无直接键表示的字符走 unicode 合成（pi-c-u 同款）。
private func physicalKeyStroke(for char: String) -> (key: String, flags: CGEventFlags)? {
  guard char.count == 1 else { return nil }
  if char >= "a" && char <= "z" { return (char, []) }
  if char >= "A" && char <= "Z" { return (char.lowercased(), [.maskShift]) }
  if char >= "0" && char <= "9" { return (char, []) }
  switch char {
  case " ": return ("space", [])
  case ".", ",", "/", "-", "=", ";", "'", "[", "]", "\\", "`": return (char, [])
  case "_": return ("-", [.maskShift])
  case "+": return ("=", [.maskShift])
  case ":": return (";", [.maskShift])
  case "\"": return ("'", [.maskShift])
  case "?": return ("/", [.maskShift])
  case "<": return (",", [.maskShift])
  case ">": return (".", [.maskShift])
  case "(": return ("9", [.maskShift])
  case ")": return ("0", [.maskShift])
  case "!": return ("1", [.maskShift])
  case "@": return ("2", [.maskShift])
  case "#": return ("3", [.maskShift])
  case "$": return ("4", [.maskShift])
  case "%": return ("5", [.maskShift])
  case "^": return ("6", [.maskShift])
  case "&": return ("7", [.maskShift])
  case "*": return ("8", [.maskShift])
  default: return nil
  }
}

private func postKey(_ key: String, flags: CGEventFlags) throws {
  guard let code = keyCode(key) else {
    if key.count == 1 { try postUnicodeText(key); return }
    throw ActionError.invalid("unsupported key '\(key)'")
  }
  guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
        let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
    throw ActionError.failed("failed to create key event")
  }
  down.flags = flags
  up.flags = flags
  post(down)
  post(up)
  usleep(8_000)
}

private func postUnicodeText(_ text: String) throws {
  for scalar in text.unicodeScalars {
    let char = String(scalar)
    if let stroke = physicalKeyStroke(for: char) {
      try postKey(stroke.key, flags: stroke.flags)
      continue
    }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
      throw ActionError.failed("unicode event")
    }
    setUnicode(down, text: char)
    setUnicode(up, text: char)
    post(down)
    post(up)
    usleep(8_000)
  }
}

private func postHotkey(_ params: [String]) throws {
  let parts = params.flatMap { $0.split(separator: "+").map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) } }
  guard parts.count >= 2, let key = parts.last else { throw ActionError.invalid("hotkey requires modifier(s)+key（e.g. cmd+c）") }
  var flags = CGEventFlags()
  for m in parts.dropLast() {
    guard let f = modifierFlag(m) else { throw ActionError.invalid("unknown modifier '\(m)'") }
    flags.insert(f)
  }
  try postKey(key, flags: flags)
}

/// 动作执行体（点坐标为 CGEvent 全局点）。
enum ActionExecutor {
  /// 目标点解析：ref（AX 元素中心）优先 → {x,y} 兜底。
  private static func targetPoint(refEl: AXUIElement?, point: CGPoint?) throws -> CGPoint {
    if let refEl { return try elementCenter(refEl) }
    guard let point else { throw ActionError.invalid("requires x,y (or ref)") }
    return point
  }
  static func run(actionType: String, params: [String: Any], point: CGPoint?, refEl: AXUIElement?) throws -> [String: Any] {
    switch actionType {
    case "move":
      guard let point else { throw ActionError.invalid("move requires x,y") }
      postMouseMove(to: point)
      return ["type": "move"]
    case "click":
      guard let point else { throw ActionError.invalid("click requires x,y") }
      let button: CGMouseButton = (params["button"] as? String) == "right" ? .right : (params["button"] as? String) == "middle" ? .center : .left
      let p = try targetPoint(refEl: refEl, point: point)
      try postClick(at: p, button: button, clickCount: 1)
      return ["type": "click", "button": button == .left ? "left" : button == .right ? "right" : "middle"]
    case "dblclick":
      let p = try targetPoint(refEl: refEl, point: point)
      try postClick(at: p, button: .left, clickCount: 2)
      return ["type": "dblclick"]
    case "rightclick":
      let p = try targetPoint(refEl: refEl, point: point)
      try postClick(at: p, button: .right, clickCount: 1)
      return ["type": "rightclick"]
    case "drag":
      guard let point else { throw ActionError.invalid("drag requires x,y") }
      let dx = (params["dx"] as? Double) ?? 0
      let dy = (params["dy"] as? Double) ?? 0
      try postDrag(from: point, to: CGPoint(x: point.x + dx, y: point.y + dy))
      return ["type": "drag", "dx": dx, "dy": dy]
    case "scroll":
      guard let point else { throw ActionError.invalid("scroll requires x,y") }
      let dx = (params["dx"] as? Double) ?? 0
      let dy = (params["dy"] as? Double) ?? 0
      postScroll(at: point, dx: Int(dx), dy: Int(dy))
      return ["type": "scroll", "dx": dx, "dy": dy]
    case "type":
      guard let text = params["text"] as? String else { throw ActionError.invalid("type requires text") }
      try postUnicodeText(text)
      return ["type": "type", "chars": text.count]
    case "hotkey":
      guard let keys = params["keys"] as? [String] else { throw ActionError.invalid("hotkey requires keys") }
      try postHotkey(keys)
      return ["type": "hotkey", "keys": keys]
    case "wait":
      let ms = (params["ms"] as? Double) ?? 0
      if ms > 0 { usleep(useconds_t(ms * 1_000)) }
      return ["type": "wait", "ms": ms]
    default:
      throw ActionError.invalid("unsupported action '\(actionType)'")
    }
  }

  private static func elementCenter(_ el: AXUIElement) throws -> CGPoint {
    let r = axRectOf(el)
    if r.isNull, r.isEmpty || r.width == 0 || r.height == 0 { throw ActionError.invalid("AX element has no bounds") }
    return CGPoint(x: r.midX, y: r.midY)
  }
}