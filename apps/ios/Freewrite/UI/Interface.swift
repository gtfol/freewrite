import SwiftUI
import UIKit

enum FreewriteStyle {
    static let canvas = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? .black : .white })
    static let text = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 238/255, alpha: 1) : UIColor(white: 17/255, alpha: 1) })
    static let secondary = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 170/255, alpha: 1) : UIColor(white: 104/255, alpha: 1) })
    static let divider = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 44/255, alpha: 1) : UIColor(white: 229/255, alpha: 1) })
    static let body = Font.custom("Lato-Regular", size: 16, relativeTo: .body)
    static let caption = Font.custom("Lato-Regular", size: 13, relativeTo: .caption)
    static let heading = Font.custom("Lato-Regular", size: 20, relativeTo: .title3)
}

extension View {
    func freewriteScreen() -> some View {
        font(FreewriteStyle.body).foregroundStyle(FreewriteStyle.text)
            .tint(FreewriteStyle.text).background(FreewriteStyle.canvas)
    }
}

struct SheetHeader: View {
    let title: String
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        HStack {
            Text(title).font(FreewriteStyle.heading)
            Spacer()
            Button("done") { dismiss() }.frame(minWidth: 44, minHeight: 44)
        }.padding(.horizontal, 20).padding(.top, 12)
    }
}
