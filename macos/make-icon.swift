// Draws the app icon into an .iconset folder: xcrun swift macos/make-icon.swift <out.iconset>
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func render(_ px: Int) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                             samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                             bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let s = CGFloat(px)
  // macOS icon grid: the tile is ~80% of the canvas with a rounded-rect corner.
  let tile = NSRect(x: s * 0.1, y: s * 0.1, width: s * 0.8, height: s * 0.8)
  let path = NSBezierPath(roundedRect: tile, xRadius: s * 0.18, yRadius: s * 0.18)
  NSGradient(starting: NSColor(red: 0.13, green: 0.16, blue: 0.21, alpha: 1),
             ending: NSColor(red: 0.05, green: 0.06, blue: 0.08, alpha: 1))!.draw(in: path, angle: -90)
  let config = NSImage.SymbolConfiguration(pointSize: s * 0.36, weight: .semibold)
    .applying(.init(paletteColors: [NSColor(red: 0.35, green: 0.65, blue: 1, alpha: 1)]))
  if let sym = NSImage(systemSymbolName: "dot.radiowaves.left.and.right", accessibilityDescription: nil)?
    .withSymbolConfiguration(config) {
    let size = sym.size
    sym.draw(in: NSRect(x: (s - size.width) / 2, y: (s - size.height) / 2, width: size.width, height: size.height))
  }
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

for base in [16, 32, 128, 256, 512] {
  try! render(base).write(to: out.appendingPathComponent("icon_\(base)x\(base).png"))
  try! render(base * 2).write(to: out.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
