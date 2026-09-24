import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

// Match freewrite's web icon: a white lowercase serif f on an opaque #111 canvas.
let context = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(gray: 17/255, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
let font = CTFontCreateWithName("Georgia" as CFString, 640, nil)

let mark = NSAttributedString(string: "f", attributes: [
    NSAttributedString.Key(kCTFontAttributeName as String): font,
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 1, alpha: 1)
])
context.textPosition = CGPoint(x: 400, y: 230)
CTLineDraw(CTLineCreateWithAttributedString(mark), context)
let url = URL(fileURLWithPath: "Freewrite/Assets.xcassets/AppIcon.appiconset/AppIcon.png")
let output = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(output, context.makeImage()!, nil)
precondition(CGImageDestinationFinalize(output))
