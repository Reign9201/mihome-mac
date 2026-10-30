#!/usr/bin/env python3
import hashlib
import json
import sys
import time

mode = sys.argv[1] if len(sys.argv) > 1 else "json"
path = sys.argv[2] if len(sys.argv) > 2 else "data/home.json"
iterations = int(sys.argv[3]) if len(sys.argv) > 3 else 10
raw = open(path, "rb").read()


def walk(payload):
    n = 0
    for home in payload["homes"]:
        for device in home["devices"]:
            n += 1
            for prop in device["props"]:
                if prop["value"] is True:
                    n += 1
    return n


if mode == "noop":
    print("ok")
elif mode in ("startup", "json"):
    loops = 1 if mode == "startup" else iterations
    start = time.perf_counter_ns()
    checksum = 0
    for _ in range(loops):
        checksum = walk(json.loads(raw))
    ns = (time.perf_counter_ns() - start) // loops
    print(f"devices={checksum} iter={loops} ns_per_iter={ns}")
elif mode == "crypto":
    from Crypto.Cipher import AES

    token = b"0123456789abcdef0123456789abcdef"
    key = hashlib.md5(token).digest()
    iv = hashlib.md5(key + token).digest()
    enc = AES.new(key, AES.MODE_CBC, iv).encrypt(b"A" * 1024)
    start = time.perf_counter_ns()
    total = 0
    for _ in range(iterations):
        total += len(AES.new(key, AES.MODE_CBC, iv).decrypt(enc))
    ns = (time.perf_counter_ns() - start) // iterations
    print(f"plain={total // iterations} iter={iterations} ns_per_iter={ns}")
else:
    print("unknown mode")
