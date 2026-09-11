import AppKit

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let images = root.appendingPathComponent("images")
let outputURL = images.appendingPathComponent("announcement-online-order.png")

let width: CGFloat = 1080
let height: CGFloat = 1350

func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> NSRect {
    NSRect(x: x, y: height - y - h, width: w, height: h)
}

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(
        calibratedRed: CGFloat((hex >> 16) & 0xff) / 255,
        green: CGFloat((hex >> 8) & 0xff) / 255,
        blue: CGFloat(hex & 0xff) / 255,
        alpha: alpha
    )
}

func font(_ name: String, _ size: CGFloat, fallback weight: NSFont.Weight = .regular) -> NSFont {
    NSFont(name: name, size: size) ?? NSFont.systemFont(ofSize: size, weight: weight)
}

func paragraph(_ alignment: NSTextAlignment = .center, lineSpacing: CGFloat = 8) -> NSMutableParagraphStyle {
    let style = NSMutableParagraphStyle()
    style.alignment = alignment
    style.lineSpacing = lineSpacing
    return style
}

func drawText(_ text: String, in box: NSRect, size: CGFloat, color textColor: NSColor, weight: NSFont.Weight = .regular, name: String = "PingFangTC-Regular", align: NSTextAlignment = .center, lineSpacing: CGFloat = 8) {
    let attrs: [NSAttributedString.Key: Any] = [
        .font: font(name, size, fallback: weight),
        .foregroundColor: textColor,
        .paragraphStyle: paragraph(align, lineSpacing: lineSpacing),
        .kern: 0
    ]
    NSString(string: text).draw(in: box, withAttributes: attrs)
}

func fillRounded(_ r: NSRect, radius: CGFloat, fill: NSColor) {
    fill.setFill()
    NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius).fill()
}

func strokeRounded(_ r: NSRect, radius: CGFloat, stroke: NSColor, lineWidth: CGFloat) {
    let path = NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius)
    stroke.setStroke()
    path.lineWidth = lineWidth
    path.stroke()
}

func loadImage(_ name: String) -> NSImage {
    let url = images.appendingPathComponent(name)
    guard let image = NSImage(contentsOf: url) else {
        fatalError("Cannot load image: \(url.path)")
    }
    return image
}

func aspectFillSourceRect(image: NSImage, dest: NSRect) -> NSRect {
    let imageSize = image.size
    let imageRatio = imageSize.width / imageSize.height
    let destRatio = dest.width / dest.height

    if imageRatio > destRatio {
        let sourceWidth = imageSize.height * destRatio
        return NSRect(x: (imageSize.width - sourceWidth) / 2, y: 0, width: sourceWidth, height: imageSize.height)
    } else {
        let sourceHeight = imageSize.width / destRatio
        return NSRect(x: 0, y: (imageSize.height - sourceHeight) / 2, width: imageSize.width, height: sourceHeight)
    }
}

func drawImage(_ image: NSImage, in box: NSRect, radius: CGFloat = 0, border: NSColor? = nil) {
    NSGraphicsContext.saveGraphicsState()
    let path = NSBezierPath(roundedRect: box, xRadius: radius, yRadius: radius)
    path.addClip()
    image.draw(in: box, from: aspectFillSourceRect(image: image, dest: box), operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()

    if let border {
        strokeRounded(box, radius: radius, stroke: border, lineWidth: 5)
    }
}

func drawPill(_ text: String, in box: NSRect, fill: NSColor, textColor: NSColor, size: CGFloat) {
    fillRounded(box, radius: box.height / 2, fill: fill)
    drawText(text, in: box.insetBy(dx: 18, dy: 16), size: size, color: textColor, weight: .semibold, name: "PingFangTC-Semibold", lineSpacing: 4)
}

let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: Int(width),
    pixelsHigh: Int(height),
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
)!

let context = NSGraphicsContext(bitmapImageRep: rep)!
NSGraphicsContext.current = context

let bg = NSGradient(colors: [color(0xfffbf0), color(0xfff1dc)])!
bg.draw(in: NSRect(x: 0, y: 0, width: width, height: height), angle: 90)

color(0xf5dbc4, 0.55).setFill()
NSBezierPath(ovalIn: rect(-180, -160, 430, 430)).fill()
NSBezierPath(ovalIn: rect(860, 1010, 360, 360)).fill()
color(0xffffff, 0.42).setFill()
NSBezierPath(ovalIn: rect(760, -90, 360, 360)).fill()

let logo = loadImage("logo.jpg")
let shrimpRice = loadImage("shrimp_rice.png")
let saltedPork = loadImage("salted_pork.png")
let eggRice = loadImage("egg_rice.jpg")
let soup = loadImage("soup.png")

drawImage(shrimpRice, in: rect(42, 84, 230, 230), radius: 36, border: color(0xffffff, 0.95))
drawImage(eggRice, in: rect(794, 110, 232, 232), radius: 36, border: color(0xffffff, 0.95))
drawImage(saltedPork, in: rect(44, 1038, 262, 210), radius: 34, border: color(0xffffff, 0.95))
drawImage(soup, in: rect(785, 1036, 230, 230), radius: 115, border: color(0xffffff, 0.95))

drawImage(logo, in: rect(420, 58, 240, 240), radius: 120, border: color(0xb93227))

drawText("邱媽媽美食", in: rect(130, 310, 820, 96), size: 82, color: color(0xb93227), weight: .heavy, name: "PingFangTC-Semibold", lineSpacing: 4)

let banner = rect(98, 424, 884, 112)
fillRounded(banner, radius: 34, fill: color(0xb93227))
drawText("線上訂餐系統正式啟用囉！", in: banner.insetBy(dx: 36, dy: 22), size: 50, color: .white, weight: .bold, name: "PingFangTC-Semibold", lineSpacing: 2)

drawText(
    "現在可以直接線上點餐了\n選好餐點後送出訂單\n我們收到後會盡快為您準備",
    in: rect(192, 582, 696, 188),
    size: 42,
    color: color(0x2d2420),
    weight: .semibold,
    name: "PingFangTC-Semibold",
    lineSpacing: 16
)

drawPill("訂餐時間", in: rect(375, 800, 330, 84), fill: color(0xd95143), textColor: .white, size: 42)

let infoBox = rect(172, 910, 736, 172)
fillRounded(infoBox, radius: 38, fill: color(0xfff7ea, 0.93))
strokeRounded(infoBox, radius: 38, stroke: color(0xe8c5a8, 0.55), lineWidth: 3)
drawText(
    "營業時間內開放線上訂餐\n非營業時間暫停接單",
    in: infoBox.insetBy(dx: 44, dy: 33),
    size: 42,
    color: color(0x372b25),
    weight: .bold,
    name: "PingFangTC-Semibold",
    lineSpacing: 20
)

drawText(
    "歡迎大家多多使用\n謝謝大家支持邱媽媽美食！",
    in: rect(160, 1128, 760, 132),
    size: 45,
    color: color(0xb93227),
    weight: .heavy,
    name: "PingFangTC-Semibold",
    lineSpacing: 18
)

drawText("家常的味道，溫暖每一天", in: rect(250, 1264, 580, 44), size: 27, color: color(0x7d5c4d), weight: .medium, name: "PingFangTC-Regular", lineSpacing: 4)

context.flushGraphics()
if let data = rep.representation(using: .png, properties: [:]) {
    try data.write(to: outputURL)
    print(outputURL.path)
}
