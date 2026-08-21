// computer-use 桥主循环（agentany / ADR-0036）：stdin JSON-lines 请求 → stdout JSON-lines 响应。
// 请求 {id, cmd:"screens"|"observe"|"act", ...}；响应 {id, ok, ...}。
// - screens：{displays:[{id,x,y,width,height,scale}], windows:[{id,number,owner,title,x,y,w,h,focused}]}
// - observe：{mode, target, target_id, image_w, image_h, phys_w, phys_h, pt:{x,y,w,h}, png_base64, outline?}
//   mode "visual"|"visual+ax"；display_id/window_id 择一（缺省主屏）；max_long_edge 降尺度上限（缺省 2048）
// - act：{action:{type,...}, ref?, x?, y?, image_w, image_h, pt:{…}} → 动作 + 后置截图
//   （type: click/dblclick/rightclick/move/drag/scroll(type:type)/hotkey/wait）
import ApplicationServices
import CoreGraphics
import Foundation

let store = AXRefStore()
let input = FileHandle.standardInput
let output = FileHandle.standardOutput

func respond(_ obj: [String: Any]) {
  // 注：不做 output.synchronizeFile()——stdout 为管道时 NSFileHandle sync 抛
  // "Operation not supported" 崩溃（bun spawn 下桥梁就是管道）；FileHandle.write 本就即时。
  if let data = try? JSONSerialization.data(withJSONObject: obj) {
    output.write(data)
    output.write(Data([0x0A]))
  }
}

func response(_ id: Int, _ body: [String: Any] = [:]) -> [String: Any] {
  var m = body
  m["id"] = id
  return m
}

func errorResponse(_ id: Int, _ message: String, code: String = "error") -> [String: Any] {
  response(id, ["ok": false, "error": message, "code": code])
}

func handleScreens(_ id: Int) -> [String: Any] {
  let displays = listDisplays()
  let windows = listWindows()
  // 前台焦点窗口中心（点空间）→ CG 窗口 bounds 含该中心者标 focused
  let focusCenter: CGPoint? = focusedWindowElement().map { r in
    let rect = axRectOf(r)
    return CGPoint(x: rect.midX, y: rect.midY)
  }
  let isFocused = { (w: WindowInfo) -> Bool in
    guard let c = focusCenter else { return false }
    return w.bounds.contains(c)
  }
  let dJson = displays.map { d -> [String: Any] in
    var j: [String: Any] = [
      "id": String(format: "%08x", d.id),
      "x": d.bounds.origin.x, "y": d.bounds.origin.y,
      "width": d.bounds.width, "height": d.bounds.height,
      "scale": d.scale,
    ]
    j["phys_w"] = CGDisplayPixelsWide(d.id)
    j["phys_h"] = CGDisplayPixelsHigh(d.id)
    return j
  }
  let wJson = windows.map { w -> [String: Any] in
    var j: [String: Any] = [
      "id": String(w.number),
      "number": w.number,
      "owner": w.owner,
      "title": w.title,
      "x": w.bounds.origin.x, "y": w.bounds.origin.y,
      "w": w.bounds.width, "h": w.bounds.height,
    ]
    if isFocused(w) { j["focused"] = true }
    // 绑定 AX 窗口（同步随批次返回；取不到 AX 时该窗口仅坐标可用）
    if let ax = axWindow(pid: w.pid, title: w.title, bounds: w.bounds) {
      j["ref"] = store.windowRef(ax)
    }
    return j
  }
  return response(id, ["ok": true, "displays": dJson, "windows": wJson])
}

func handleObserve(_ id: Int, _ req: [String: Any]) -> [String: Any] {
  let mode = (req["mode"] as? String) ?? "visual"
  let displayId = req["display_id"] as? String
  let windowId = (req["window_id"] as? NSNumber)?.int64Value
  let maxLong = (req["max_long_edge"] as? NSNumber)?.intValue ?? DEFAULT_MAX_LONG_EDGE
  let fmt = (req["image_format"] as? String) == "jpeg" ? "jpeg" : "png"
  let quality = Double((req["quality"] as? NSNumber)?.doubleValue ?? 0.8)

  guard let target = resolveCaptureTarget(displayId: displayId, windowId: windowId) else {
    return errorResponse(id, "unknown target（display_id=\(displayId ?? "?"), window_id=\(String(describing: windowId))）", code: "unknown_target")
  }
  let img: CGImage
  do {
    img = try captureImage(target)
  } catch {
    return errorResponse(id, (error as? CaptureError)?.localizedDescription(with: target) ?? "\(error)", code: "capture_failed")
  }
  let shot = snap(img, maxLongEdge: maxLong, format: fmt, quality: quality)

  var resp: [String: Any] = [
    "ok": true,
    "mode": mode,
    "target": target.kind,
    "target_id": target.id,
    "image_w": shot.w, "image_h": shot.h,
    "phys_w": target.physW, "phys_h": target.physH,
    "pt": ["x": target.ptRect.origin.x, "y": target.ptRect.origin.y,
           "w": target.ptRect.width, "h": target.ptRect.height],
    "png_base64": shot.data.base64EncodedString(),
    "image_ext": shot.ext,
  ]
  if mode == "visual+ax" {
    let root: AXUIElement? =
      target.kind == "window" ? target.axElement
      : (target.axElement ?? focusedWindowElement())
    if let root {
      let tree = outlineTree(root: root, store: store, ptRect: target.ptRect,
                             imgW: shot.w, imgH: shot.h, maxDepth: 10, maxNodes: 2000)
      if !tree.isEmpty { resp["outline"] = tree }
    }
  }
  return response(id, resp)
}

func handleAct(_ id: Int, _ req: [String: Any]) -> [String: Any] {
  guard let action = req["action"] as? [String: Any], let type = action["type"] as? String else {
    return errorResponse(id, "act requires action.type", code: "invalid_args")
  }
  let pt = req["pt"] as? [String: Any] ?? [:]
  let ptRect = CGRect(
    x: (pt["x"] as? Double) ?? 0, y: (pt["y"] as? Double) ?? 0,
    width: (pt["w"] as? Double) ?? 0, height: (pt["h"] as? Double) ?? 0)
  let imgW = (req["image_w"] as? NSNumber)?.doubleValue ?? 0
  let imgH = (req["image_h"] as? NSNumber)?.doubleValue ?? 0

  // 目标解析：ref（AX 元素）优先；否则 x,y（image px → CG 点）
  var refEl: AXUIElement?
  if let ref = req["ref"] as? String {
    refEl = store.element(ref)
    if refEl == nil { return errorResponse(id, "unknown ref '\(ref)'（先 observe 取得有效 ref）", code: "stale_ref") }
  }
  var point: CGPoint?
  if let x = (req["x"] as? NSNumber)?.doubleValue, let y = (req["y"] as? NSNumber)?.doubleValue {
    guard ptRect.width > 0, ptRect.height > 0, imgW > 0, imgH > 0 else {
      return errorResponse(id, "act x/y requires image_w/h + pt（自 observe 返回回传）", code: "invalid_args")
    }
    point = CGPoint(
      x: ptRect.origin.x + x * (ptRect.width / imgW),
      y: ptRect.origin.y + y * (ptRect.height / imgH))
  }
  // 注：不做通用 ref/坐标强校验——wait/type/hotkey 等无目标动作合法；
  // 坐标类动作（move/click/drag/scroll…）的必填校验在 ActionExecutor 各分支 guard。

  let performed: [String: Any]
  do {
    performed = try ActionExecutor.run(actionType: type, params: action, point: point, refEl: refEl)
  } catch let e as ActionError {
    return errorResponse(id, "\(e)", code: "action_failed")
  } catch {
    return errorResponse(id, "\(error)", code: "action_failed")
  }

  // 后置截图：默认与目标同一显示器（act 有 ref/explicit display_id 则用其 target）
  var resp: [String: Any] = ["ok": true, "action": performed]
  if let capture = postCaptureTarget(req: req, fallbackPoint: point) {
    if let img = try? captureImage(capture) {
      let fmt = (req["image_format"] as? String) == "jpeg" ? "jpeg" : "png"
      let quality = Double((req["quality"] as? NSNumber)?.doubleValue ?? 0.8)
      let shot = snap(img, maxLongEdge: (req["max_long_edge"] as? NSNumber)?.intValue ?? DEFAULT_MAX_LONG_EDGE,
                      format: fmt, quality: quality)
      resp["image_w"] = shot.w
      resp["image_h"] = shot.h
      resp["png_base64"] = shot.data.base64EncodedString()
      resp["image_ext"] = shot.ext
    }
  }
  return response(id, resp)
}

/// act 后置截图的捕获目标：display_id 显式首选 → ref 元素所在显示器 → 坐标 point 所在显示器 → 主屏。
func postCaptureTarget(req: [String: Any], fallbackPoint: CGPoint? = nil) -> CaptureTarget? {
  if let d = req["display_id"] as? String {
    return resolveCaptureTarget(displayId: d, windowId: nil)
  }
  if let point = fallbackPoint {
    for d in listDisplays() where d.bounds.contains(point) {
      return CaptureTarget(kind: "display", id: String(format: "%08x", d.id), ptRect: d.bounds,
                           physW: CGDisplayPixelsWide(d.id), physH: CGDisplayPixelsHigh(d.id), axElement: nil)
    }
  }
  return resolveCaptureTarget(displayId: String(format: "%08x", CGMainDisplayID()), windowId: nil)
}

extension CaptureError {
  func localizedDescription(with target: CaptureTarget) -> String {
    switch self {
    case .imageFailed(let m): return "\(m)"
    }
  }
}

// —— stdin 循环 ——
var buffer = Data()
while true {
  let chunk = input.availableData
  if chunk.isEmpty { break }
  buffer.append(chunk)
  while let nl = buffer.firstIndex(of: 0x0A) {
    let line = buffer.subdata(in: buffer.startIndex..<nl)
    buffer.removeSubrange(buffer.startIndex...nl)
    guard !line.isEmpty, let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
          let cmd = obj["cmd"] as? String else { continue }
    let reqId = (obj["id"] as? Int) ?? 0
    let resp: [String: Any]
    switch cmd {
    case "screens": resp = handleScreens(reqId)
    case "observe": resp = handleObserve(reqId, obj)
    case "act": resp = handleAct(reqId, obj)
    default: resp = errorResponse(reqId, "unknown cmd '\(cmd)'", code: "unknown_cmd")
    }
    respond(resp)
  }
}