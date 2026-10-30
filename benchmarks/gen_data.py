#!/usr/bin/env python3
"""生成贴近米家云端返回结构的基准数据。

字段参考 mijiaAPI 的 home_device_list / miot-spec 结构，故意保留多余字段，
让解码器承担真实体积。默认 3 个家庭、120 台设备、每台 40 条属性。
"""

import json
import random
import sys
from pathlib import Path

random.seed(20261029)

PROP_NAMES = [
    ("on", "bool", True), ("brightness", "uint8", 62), ("color-temperature", "uint32", 4000),
    ("mode", "uint8", 2), ("fan-level", "uint8", 3), ("target-temperature", "float", 24.0),
    ("current-temperature", "float", 23.6), ("relative-humidity", "uint8", 58),
    ("pm2.5-density", "uint16", 12), ("battery-level", "uint8", 87), ("charging-state", "uint8", 2),
    ("status", "uint8", 6), ("fault", "uint8", 0), ("filter-life-level", "uint8", 76),
    ("supply-fan-level", "uint8", 2), ("purpose", "uint8", 0), ("target-position", "uint8", 60),
    ("current-position", "uint8", 60), ("motor-reverse", "bool", False), ("power-consumption", "float", 46.2),
    ("electric-power", "float", 46.2), ("voltage", "float", 220.1), ("electric-current", "float", 0.21),
    ("temperature", "float", 24.6), ("illumination", "uint32", 340), ("aqi", "uint8", 32),
    ("screen-brightness", "uint8", 60), ("child-lock", "bool", False), ("indicator-light", "bool", True),
    ("alarm", "bool", False), ("volume", "uint8", 30), ("mute", "bool", False),
    ("water-level", "uint8", 55), ("target-humidity", "uint8", 55), ("fan-speed", "uint8", 2),
    ("swing-mode", "uint8", 1), ("sleep-mode", "bool", False), ("turbo-mode", "bool", False),
    ("eco-mode", "bool", False), ("heating", "bool", False),
]

ACCESS = [["read", "write", "notify"], ["read", "notify"], ["read", "write"]]


def make_props(n=40):
    props = []
    for i in range(n):
        name, fmt, value = PROP_NAMES[i % len(PROP_NAMES)]
        prop = {
            "iid": i + 1,
            "siid": 2 + i // 12,
            "piid": i + 1,
            "type": f"urn:miot-spec-v2:property:{name}:0000{i:04X}:demo:1",
            "description": name,
            "format": fmt,
            "access": ACCESS[i % len(ACCESS)],
            "value": value if i < len(PROP_NAMES) else value,
            "unit": "percentage" if name in ("brightness", "battery-level", "filter-life-level") else "",
            "value-range": [1, 100, 1] if name == "brightness" else None,
            "value-list": [{"value": 0, "description": "Auto"}, {"value": 1, "description": "Level1"}] if name == "mode" else None,
            "notify": True,
            "update_time": 1793264000 + i,
            "extra": {"vendor": "demo", "index": i, "flags": [1, 2, 3, 4]},
        }
        props.append(prop)
    return props


ROOMS = ["客厅", "主卧", "书房", "厨房", "阳台", "次卧", "玄关"]
MODELS = [
    ("yeelink.light.lamp4", "light"),
    ("xiaomi.aircondition.mc5", "air-conditioner"),
    ("lumi.curtain.hagl05", "curtain"),
    ("zhimi.airpurifier.va1", "air-purifier"),
    ("dreame.vacuum.p2009", "vacuum"),
    ("lumi.sensor_ht.htv1", "temperature-humidity-sensor"),
    ("lumi.plug.ugv1", "outlet"),
    ("zhimi.humidifier.ca4", "humidifier"),
]
NAMES = ["主灯", "空调", "窗帘", "净化器", "扫地机", "温湿度计", "插座", "加湿器", "灯带", "台灯"]


def main():
    device_count = int(sys.argv[1]) if len(sys.argv) > 1 else 120
    out = Path(__file__).with_name("data") / "home.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    homes = []
    for h in range(3):
        rooms = [{"id": 1000 + h * 10 + r, "name": name, "dids": []} for r, name in enumerate(ROOMS)]
        devices = []
        for d in range(device_count // 3):
            model, category = MODELS[(h + d) % len(MODELS)]
            name = f"{rooms[d % len(ROOMS)]['name']}{NAMES[(h + d) % len(NAMES)]}"
            did = f"{600000000 + h * 100000 + d}"
            rooms[d % len(ROOMS)]["dids"].append(did)
            devices.append({
                "did": did,
                "uid": 1234567890 + h,
                "name": name,
                "model": model,
                "spec_type": f"urn:miot-spec-v2:device:{category}:0000A001:demo-{d}:1",
                "home_id": str(9000 + h),
                "room_id": rooms[d % len(ROOMS)]["id"],
                "room_name": rooms[d % len(ROOMS)]["name"],
                "isOnline": True,
                "rssi": -35 - (d % 40),
                "localip": f"192.168.31.{20 + d}",
                "token": "0123456789abcdef0123456789abcdef",
                "order_time": 1793000000 + d,
                "device_type": category,
                "props": make_props(40),
                "extra": {"owner": "demo", "share": False, "mesh": d % 7 == 0},
            })
        homes.append({
            "id": str(9000 + h),
            "name": ["云栖公寓", "湖畔小筑", "老家"][h],
            "uid": 1234567890 + h,
            "roomlist": rooms,
            "devices": devices,
        })
    payload = {"code": 0, "message": "ok", "homes": homes, "server_time": 1793264544}
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size / 1024:.1f} KiB), devices={device_count}")


if __name__ == "__main__":
    main()
