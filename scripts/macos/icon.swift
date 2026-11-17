import AppKit

// Deterministic source artwork. Packaging downsamples this 1024px AppKit master.
let output = CommandLine.arguments[1]
let bitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024,
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
let context = NSGraphicsContext.current!.cgContext
context.setAllowsAntialiasing(true)
func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
  NSColor(
    srgbRed: CGFloat((hex >> 16) & 255) / 255,
    green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: alpha)
}
func rounded(_ rect: NSRect, _ radius: CGFloat) -> NSBezierPath {
  NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
}
func gradient(_ path: NSBezierPath, _ top: UInt32, _ bottom: UInt32) {
  NSGradient(starting: color(bottom), ending: color(top))!.draw(in: path, angle: 90)
}
// A graphite ceramic tile with restrained teal light and the standard macOS inset.
let tile = rounded(NSRect(x: 96, y: 96, width: 832, height: 832), 184)
NSGraphicsContext.saveGraphicsState()
let shadow = NSShadow()
shadow.shadowColor = color(0x071923, 0.3)
shadow.shadowBlurRadius = 28
shadow.shadowOffset = NSSize(width: 0, height: -12)
shadow.set()
gradient(tile, 0x28464C, 0x101F27)
NSGraphicsContext.restoreGraphicsState()
color(0xA7F3D0, 0.25).setStroke()
tile.lineWidth = 3
tile.stroke()
// Inset vault door and its soft bevel.
let outerDoor = rounded(NSRect(x: 238, y: 238, width: 548, height: 548), 112)
gradient(outerDoor, 0x8CF4D4, 0x247D76)
let door = rounded(NSRect(x: 254, y: 254, width: 516, height: 516), 99)
gradient(door, 0x2F6A65, 0x123B40)
color(0x071E28, 0.6).setStroke()
door.lineWidth = 6
door.stroke()
// Two substantial hinges provide a recognizable vault silhouette at small sizes.
for y in [340, 600] {
  let hinge = rounded(NSRect(x: 214, y: y, width: 64, height: 94), 20)
  gradient(hinge, 0xB3FAE2, 0x419B8D)
}
// Three environment-setting grooves, kept large enough for the Dock.
for y in [354, 482, 610] {
  let groove = rounded(NSRect(x: 305, y: y, width: 414, height: 60), 25)
  color(0x08282F, 0.8).setFill()
  groove.fill()
  let indicator = rounded(NSRect(x: 320, y: y + 13, width: 34, height: 34), 12)
  gradient(indicator, 0xC2FFDE, 0x5CE4B1)
}
// The luminous central vault wheel: a simple four-spoke cross over a dark dial.
let center = NSPoint(x: 536, y: 512)
let rim = NSBezierPath(
  ovalIn: NSRect(x: center.x - 148, y: center.y - 148, width: 296, height: 296))
NSGraphicsContext.saveGraphicsState()
let dialShadow = NSShadow()
dialShadow.shadowColor = color(0x001015, 0.65)
dialShadow.shadowBlurRadius = 14
dialShadow.shadowOffset = NSSize(width: 0, height: -10)
dialShadow.set()
gradient(rim, 0xDAFFF0, 0x60C9AE)
NSGraphicsContext.restoreGraphicsState()
let dial = NSBezierPath(
  ovalIn: NSRect(x: center.x - 122, y: center.y - 122, width: 244, height: 244))
gradient(dial, 0x25595C, 0x102E38)
for angle in [CGFloat(0), .pi / 2, .pi, .pi * 1.5] {
  let spoke = NSBezierPath()
  spoke.move(to: NSPoint(x: center.x + cos(angle) * 35, y: center.y + sin(angle) * 35))
  spoke.line(to: NSPoint(x: center.x + cos(angle) * 87, y: center.y + sin(angle) * 87))
  spoke.lineWidth = 26
  spoke.lineCapStyle = .round
  color(0xBBFFE3).setStroke()
  spoke.stroke()
}
let hub = NSBezierPath(ovalIn: NSRect(x: center.x - 39, y: center.y - 39, width: 78, height: 78))
gradient(hub, 0xE2FFF2, 0x7BDBBA)
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
