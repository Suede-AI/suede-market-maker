import Foundation

let bundleURL = Bundle.main.bundleURL
let bundledRootURL = bundleURL.deletingLastPathComponent()
let currentDirectoryURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let rootURL = [bundledRootURL, currentDirectoryURL].first {
  FileManager.default.fileExists(atPath: $0.appendingPathComponent("scripts/open-dashboard.js").path)
} ?? bundledRootURL
let logURL = rootURL.appendingPathComponent("dashboard.log")
let scriptURL = rootURL.appendingPathComponent("scripts/open-dashboard.js")

let nodeCandidates = [
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node"
]

guard let nodePath = nodeCandidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
  let message = "Could not find Node. Install Node with Homebrew or run npm run app from Terminal.\n"
  FileManager.default.createFile(atPath: logURL.path, contents: nil)
  if let handle = try? FileHandle(forWritingTo: logURL) {
    _ = try? handle.seekToEnd()
    if let data = message.data(using: .utf8) {
      handle.write(data)
    }
  }
  exit(1)
}

let process = Process()
process.currentDirectoryURL = rootURL
process.executableURL = URL(fileURLWithPath: nodePath)
process.arguments = [scriptURL.path]

if FileManager.default.fileExists(atPath: logURL.path) == false {
  FileManager.default.createFile(atPath: logURL.path, contents: nil)
}

let logHandle = try FileHandle(forWritingTo: logURL)
try logHandle.seekToEnd()
process.standardOutput = logHandle
process.standardError = logHandle

try process.run()
process.waitUntilExit()
