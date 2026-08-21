// screens（显示器 + 在线窗口 + AX 绑定）与 observe（截图 + 降尺度 + 可选 AX outline）。
// 坐标契约：observe 返回 {image_w/H: 交付截图像素, phys_w/H: 目标原生物理像素, pt:{x,y,w,h}: 目标设备点矩形};
// act 的 {x,y} 以 image_w/H 为系，桥按 pt 换算 CGEvent 全局点坐标（display 与 window 目标同式）。
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO

/// 建议截图长边上限（Claude 类模型图片上限 ≈2576px；ADR-0036 D2）。
let DEFAULT_MAX_LONG_EDGE = 2048

// —— 显示器 ——
struct DisplayInfo {
  let id: UInt32
  let bounds: CGRect // 点
  let scale: Double // 像素/点
}

func listDisplays() -> [DisplayInfo] {
  var count: UInt32 = 0
  guard CGGetOnlineDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  guard CGGetOnlineDisplayList(count, &ids, &count) == .success else { return [] }
  return ids.prefix(Int(count)).map { id in
    let b = CGDisplayBounds(id)
    let pw = Double(CGDisplayPixelsWide(id))
    let scale = b.width > 0 ? pw / Double(b.width) : 1.0
    return DisplayInfo(id: id, bounds: b, scale: scale)
  }
}

// —— 窗口（CGWindowList；需要屏幕录制权限）——
struct WindowInfo {
  let number: Int64
  let owner: String
  let title: String
  let bounds: CGRect // 点（kCGWindowBounds）
  let pid: Int32
  let onscreen: Bool
}

func listWindows() -> [WindowInfo] {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  return list.compactMap { w in
    guard let number = w[kCGWindowNumber as String] as? Int64 else { return nil }
    let onscreen = ((w[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue) ?? false
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    return WindowInfo(
      number: number,
      owner: (w[kCGWindowOwnerName as String] as? String) ?? "",
      title: (w[kCGWindowName as String] as? String) ?? "",
      bounds: CGRect(x: (b["X"] as? Double) ?? 0, y: (b["Y"] as? Double) ?? 0,
                     width: (b["Width"] as? Double) ?? 0, height: (b["Height"] as? Double) ?? 0),
      pid: (w[kCGWindowOwnerPID as String] as? Int32) ?? 0,
      onscreen: onscreen)
  }
}

// —— 观察目标（显示器或窗口）——
struct CaptureTarget {
  let kind: String // "display" | "window"
  let id: String
  let ptRect: CGRect // 点矩形（坐标换算基准）
  let physW: Int
  let physH: Int
  let axElement: AXUIElement? // window 目标绑定 AX 账（outline/ref）；display 目标 = 前台应用聚焦窗口子树
}

func resolveCaptureTarget(displayId: String?, windowId: Int64?) -> CaptureTarget? {
  if let windowId, windowId > 0 {
    guard let w = listWindows().first(where: { $0.number == windowId }) else { return nil }
    return CaptureTarget(
      kind: "window", id: String(windowId), ptRect: w.bounds,
      physW: Int(w.bounds.width), physH: Int(w.bounds.height),
      axElement: axWindow(pid: w.pid, title: w.title, bounds: w.bounds))
  }
  let tid = displayId ?? String(format: "%08x", CGMainDisplayID())
  guard let d = listDisplays().first(where: { String(format: "%08x", $0.id) == tid || String($0.id) == tid }) else { return nil }
  return CaptureTarget(
    kind: "display", id: String(format: "%08x", d.id), ptRect: d.bounds,
    physW: CGDisplayPixelsWide(d.id), physH: CGDisplayPixelsHigh(d.id), axElement: nil)
}

/// 前台应用第一个 AX 窗口（display 目标的 outline 根）。
func focusedWindowElement() -> AXUIElement? {
  guard let app = frontmostAppElement() else { return nil }
  if let w = axCopy(app, kAXFocusedWindowAttribute as CFString) { return (w as! AXUIElement) }
  if let wins = axCopy(app, kAXWindowsAttribute as CFString) as? [AXUIElement], let first = wins.first { return first }
  return nil
}

// —— 截图 + 降尺度 ——
enum CaptureError: Error { case imageFailed(String) }

func captureImage(_ target: CaptureTarget) throws -> CGImage {
  if target.kind == "display", let id = UInt32(target.id, radix: 16), let img = CGDisplayCreateImage(id) {
    return img
  }
  if target.kind == "window", let n = Int64(target.id),
     let img = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(n), [.boundsIgnoreFraming]) {
    return img
  }
  throw CaptureError.imageFailed("capture failed for \(target.kind) \(target.id)（屏幕录制权限？）")
}

func encodedDataOf(_ img: CGImage, format: String, quality: Double) -> Data {
  let uti = format == "jpeg" ? "public.jpeg" : "public.png"
  let d = NSMutableData()
  var props: CFDictionary?
  if format == "jpeg" {
    props = [kCGImageDestinationLossyCompressionQuality: min(max(quality, 0), 1)] as CFDictionary
  }
  if let dst = CGImageDestinationCreateWithData(d as CFMutableData, uti as CFString, 1, props) {
    CGImageDestinationAddImage(dst, img, nil)
    CGImageDestinationFinalize(dst)
  }
  return d as Data
}

/// 压缩编码（默认 PNG；request 可选 image_format:"jpeg"+quality 商务压缩图给模型/传输），必要时按 maxLongEdge 降尺度（长边等比）。
/// 返回 (data, imageW, imageH)。extension：jpeg→"jpg"。
func snap(_ img: CGImage, maxLongEdge: Int, format: String = "png", quality: Double = 0.8) -> (data: Data, w: Int, h: Int, ext: String) {
  let ext = format == "jpeg" ? "jpg" : "png"
  let raw = encodedDataOf(img, format: format, quality: quality)
  let long = max(img.width, img.height)
  guard long > maxLongEdge else { return (raw, img.width, img.height, ext) }
  guard let src = CGImageSourceCreateWithData(raw as CFData, nil) else { return (raw, img.width, img.height, ext) }
  let opts: [CFString: Any] = [
    kCGImageSourceCreateThumbnailFromImageIfAbsent: true,
    kCGImageSourceThumbnailMaxPixelSize: maxLongEdge,
    kCGImageSourceCreateThumbnailWithTransform: true,
  ]
  guard let thumb = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return (raw, img.width, img.height, ext) }
  return (encodedDataOf(thumb, format: format, quality: quality), thumb.width, thumb.height, ext)
}

// —— AX outline ——
/// 从给定根遍历 AX 树（去环、深度/总量封顶、滤隐形/越界），节点带 e# ref 并存仓（act {ref} 用）。
/// 坐标换算：imageX = (axX - ptRect.x) * (imgW / ptRect.w)（AX 与 CG 同为左上原点点坐标）。
func outlineTree(root: AXUIElement, store: AXRefStore, ptRect: CGRect, imgW: Int, imgH: Int,
                 maxDepth: Int, maxNodes: Int) -> [String: Any] {
  var count = 0
  func node(_ el: AXUIElement, depth: Int, ancestors: [CFHashCode]) -> [String: Any]? {
    if depth >= maxDepth || count >= maxNodes { return nil }
    let role = axString(el, kAXRoleAttribute as CFString) ?? ""
    if role.isEmpty || role == "AXApplication" { return nil }
    let h: CFHashCode = CFHash(el)
    if ancestors.contains(h) { return nil } // 环
    if axBool(el, kAXHiddenAttribute as CFString) { return nil }
    let rect = axRectOf(el)
    if !rect.isNull, !rect.isEmpty, !rect.intersects(ptRect) { return nil } // 越界滤（无 rect 的元素保留）
    count += 1
    let title = axString(el, kAXTitleAttribute as CFString) ?? ""
    let desc = axString(el, kAXDescriptionAttribute as CFString) ?? ""
    let ref = store.elementRef(el, info: .init(role: role, title: title, desc: desc))
    var out: [String: Any] = ["ref": ref, "role": role]
    if title.isEmpty && !desc.isEmpty { out["desc"] = desc } else if !title.isEmpty { out["title"] = title }
    if !rect.isNull, !rect.isEmpty, ptRect.width > 0, ptRect.height > 0 {
      out["x"] = (rect.origin.x - ptRect.origin.x) * (Double(imgW) / ptRect.width)
      out["y"] = (rect.origin.y - ptRect.origin.y) * (Double(imgH) / ptRect.height)
      out["w"] = rect.width * (Double(imgW) / ptRect.width)
      out["h"] = rect.height * (Double(imgH) / ptRect.height)
    }
    var children: [[String: Any]] = []
    if let kids = axCopy(el, kAXChildrenAttribute as CFString) as? [AXUIElement] {
      for k in kids {
        if let c = node(k, depth: depth + 1, ancestors: ancestors + [h]) { children.append(c) }
      }
    }
    if !children.isEmpty { out["children"] = children }
    return out
  }
  return node(root, depth: 0, ancestors: []) ?? [:]
}