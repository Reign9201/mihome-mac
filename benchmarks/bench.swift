import Foundation
import CommonCrypto

enum JSONValue: Codable {
    case bool(Bool), int(Int), double(Double), string(String), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Int.self) { self = .int(v) }
        else if let v = try? c.decode(Double.self) { self = .double(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else { self = .null }
    }
}

struct Prop: Codable {
    let iid: Int; let siid: Int; let piid: Int; let type: String
    let description: String; let format: String; let access: [String]
    let value: JSONValue; let unit: String?
    let valueRange: [Int]?
    let notify: Bool
    enum CodingKeys: String, CodingKey {
        case iid, siid, piid, type, description, format, access, value, unit, notify
        case valueRange = "value-range"
    }
}

struct Device: Codable {
    let did: String; let name: String; let model: String
    let specType: String; let isOnline: Bool; let rssi: Int?
    let localip: String?; let props: [Prop]
    enum CodingKeys: String, CodingKey {
        case did, name, model, isOnline, rssi, localip, props
        case specType = "spec_type"
    }
}

struct Room: Codable { let id: Int; let name: String; let dids: [String] }
struct Home: Codable { let id: String; let name: String; let roomlist: [Room]; let devices: [Device] }
struct Payload: Codable { let code: Int; let homes: [Home] }

func md5(_ bytes: [UInt8]) -> [UInt8] {
    var digest = [UInt8](repeating: 0, count: Int(CC_MD5_DIGEST_LENGTH))
    bytes.withUnsafeBytes { CC_MD5($0.baseAddress, CC_LONG(bytes.count), &digest) }
    return digest
}

func aesDecrypt(_ data: Data, key: [UInt8], iv: [UInt8]) -> Data? {
    var out = Data(count: data.count + kCCBlockSizeAES128)
    let outCount = out.count
    var moved = 0
    let status = out.withUnsafeMutableBytes { outPtr in
        data.withUnsafeBytes { inPtr in
            key.withUnsafeBytes { keyPtr in
                iv.withUnsafeBytes { ivPtr in
                    CCCrypt(CCOperation(kCCDecrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding),
                            keyPtr.baseAddress, key.count, ivPtr.baseAddress,
                            inPtr.baseAddress, data.count, outPtr.baseAddress, outCount, &moved)
                }
            }
        }
    }
    guard status == kCCSuccess else { return nil }
    out.removeSubrange(moved..<out.count)
    return out
}

let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "json"
let path = args.count > 2 ? args[2] : "data/home.json"
let iterations = args.count > 3 ? Int(args[3]) ?? 30 : 30
let url = URL(fileURLWithPath: path)
let data = try! Data(contentsOf: url)

switch mode {
case "noop":
    print("ok")
case "startup", "json":
    var checksum = 0
    let loops = mode == "startup" ? 1 : iterations
    let start = DispatchTime.now().uptimeNanoseconds
    for _ in 0..<loops {
        let payload = try! JSONDecoder().decode(Payload.self, from: data)
        checksum = payload.homes.reduce(0) { $0 + $1.devices.count }
    }
    let ns = DispatchTime.now().uptimeNanoseconds - start
    print("devices=\(checksum) iter=\(loops) ns_per_iter=\(ns / UInt64(loops))")
case "json_foundation":
    var checksum = 0
    let start = DispatchTime.now().uptimeNanoseconds
    for _ in 0..<iterations {
        let obj = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        let homes = obj["homes"] as! [[String: Any]]
        for home in homes {
            let devices = home["devices"] as! [[String: Any]]
            checksum += devices.count
            for device in devices {
                _ = device["name"] as? String
                _ = (device["props"] as? [[String: Any]])?.count
            }
        }
    }
    let ns = DispatchTime.now().uptimeNanoseconds - start
    print("devices=\(checksum) iter=\(iterations) ns_per_iter=\(ns / UInt64(iterations))")
case "crypto":
    let token = Array("0123456789abcdef0123456789abcdef".utf8)
    let key = md5(token)
    let iv = md5(key + token)
    let plain = Data(repeating: 0x41, count: 1024)
    // 生成密文：用同一份 CCCrypt 逻辑做加密，避免依赖额外库
    var enc = Data(count: plain.count + kCCBlockSizeAES128)
    let encCount = enc.count
    var moved = 0
    _ = enc.withUnsafeMutableBytes { outPtr in
        plain.withUnsafeBytes { inPtr in
            key.withUnsafeBytes { keyPtr in
                iv.withUnsafeBytes { ivPtr in
                    CCCrypt(CCOperation(kCCEncrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding),
                            keyPtr.baseAddress, key.count, ivPtr.baseAddress,
                            inPtr.baseAddress, plain.count, outPtr.baseAddress, encCount, &moved)
                }
            }
        }
    }
    enc.removeSubrange(moved..<enc.count)
    let start = DispatchTime.now().uptimeNanoseconds
    var total = 0
    for _ in 0..<iterations { total += aesDecrypt(enc, key: key, iv: iv)?.count ?? 0 }
    let ns = DispatchTime.now().uptimeNanoseconds - start
    print("plain=\(total / iterations) iter=\(iterations) ns_per_iter=\(ns / UInt64(iterations))")
default:
    print("unknown mode")
}
