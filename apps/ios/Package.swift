// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "FreewriteCore",
    platforms: [.macOS(.v14), .iOS(.v26)],
    products: [.library(name: "FreewriteCore", targets: ["FreewriteCore"])],
    targets: [
        .target(name: "FreewriteCore", path: "Freewrite/Core"),
        .testTarget(name: "FreewriteCoreTests", dependencies: ["FreewriteCore"],
                    path: "FreewriteTests", exclude: ["PersistenceTests.swift"])
    ]
)
