import SwiftUI
import UIKit

enum FreewriteStyle {
    static let canvas = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? .black : .white })
    static let text = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 238/255, alpha: 1) : UIColor(white: 17/255, alpha: 1) })
    static let secondary = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 170/255, alpha: 1) : UIColor(white: 104/255, alpha: 1) })
    static let divider = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 44/255, alpha: 1) : UIColor(white: 229/255, alpha: 1) })
    static let body = Font.custom("Lato-Regular", size: 15, relativeTo: .subheadline)
    static let caption = Font.custom("Lato-Regular", size: 13, relativeTo: .footnote)
    static let heading = Font.custom("Lato-Regular", size: 17, relativeTo: .headline)
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

struct InfoButton: View {
    let title: String
    let paragraphs: [String]
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var showingInfo = false

    var body: some View {
        Button { showingInfo = true } label: {
            Image(systemName: "info.circle")
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(FreewriteStyle.secondary)
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("about \(title)")
        .accessibilityHint("opens more information")
        .popover(isPresented: $showingInfo, arrowEdge: .top) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text(title).font(FreewriteStyle.heading)
                        Spacer(minLength: 8)
                        Button { showingInfo = false } label: {
                            Image(systemName: "xmark").font(.system(size: 12))
                                .frame(width: 44, height: 44).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityLabel("close information")
                    }
                    ForEach(paragraphs, id: \.self) { paragraph in
                        Text(paragraph).font(FreewriteStyle.caption)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }.padding(20)
            }
            .frame(idealWidth: dynamicTypeSize.isAccessibilitySize ? nil : 280,
                   maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : 320,
                   idealHeight: dynamicTypeSize.isAccessibilitySize ? nil : 280,
                   maxHeight: dynamicTypeSize.isAccessibilitySize ? .infinity : 420)
            .freewriteScreen()
            .presentationBackground(FreewriteStyle.canvas)
            .presentationCompactAdaptation(dynamicTypeSize.isAccessibilitySize ? .sheet : .popover)
        }
    }
}
