#!/usr/bin/env python3
"""STARK twin gateway: reads the MT AC station's PLC and streams its I/O to the twin page.

  python gateway.py --demo          scripted I/O, no PLC needed (to try the live view)
  python gateway.py                 read the real S7-300 using map.json

The twin page connects to ws://localhost:8765 (Drive tab > Connect).
Read-only: this program never writes to the PLC.
"""
import argparse, asyncio, json, re, time
from pathlib import Path

import websockets

ADDR = re.compile(r"^([IQ])(W?)(\d+)(?:\.(\d))?$")


def parse(addr):
    m = ADDR.match(addr.strip().upper())
    if not m:
        raise ValueError(f"bad address: {addr}")
    area, word, byte, bit = m.groups()
    if word:
        return area, int(byte), None
    if bit is None:
        raise ValueError(f"bit address needs a bit number: {addr}")
    return area, int(byte), int(bit)


class S7Source:
    """Reads input/output bytes from an S7-300 over ISO-on-TCP (needs a CP 343-1 or an MPI/PROFIBUS-Ethernet adapter)."""

    def __init__(self, cfg):
        import snap7
        self.snap7 = snap7
        self.cfg = cfg
        self.client = snap7.client.Client()
        self.items = {"in": {k: parse(v) for k, v in cfg["inputs"].items()},
                      "out": {k: parse(v) for k, v in cfg["outputs"].items()},
                      "drv": {k: parse(v) for k, v in cfg["words"].items()}}
        # one read per contiguous block, per area
        self.blocks = {}
        for group in self.items.values():
            for area, byte, bit in group.values():
                size = 1 if bit is not None else 2
                key = (area, 0 if byte < 200 else 1)   # process image block / peripheral block
                lo, hi = self.blocks.get(key, (byte, byte + size))
                self.blocks[key] = (min(lo, byte), max(hi, byte + size))

    def connect(self):
        p = self.cfg["plc"]
        if not self.client.get_connected():
            self.client.connect(p["ip"], p.get("rack", 0), p.get("slot", 2), p.get("port", 102))

    def _area(self, area):
        s = self.snap7
        A = getattr(s, "Area", None) or s.types.Areas
        return A.PE if area == "I" else A.PA

    def read(self):
        self.connect()
        data = {}
        for (area, blk), (lo, hi) in self.blocks.items():
            data[(area, blk)] = (lo, bytes(self.client.read_area(self._area(area), 0, lo, hi - lo)))

        def get(area, byte, bit):
            lo, buf = data[(area, 0 if byte < 200 else 1)]
            if bit is None:
                return int.from_bytes(buf[byte - lo:byte - lo + 2], "big")
            return (buf[byte - lo] >> bit) & 1

        return {g: {k: get(*a) for k, a in items.items()} for g, items in self.items.items()}


class DemoSource:
    """A scripted cycle so the live view can be tried without a PLC."""

    def __init__(self):
        self.t0 = time.time()
        self.n = 0

    def read(self):
        T = 9.0
        t = (time.time() - self.t0)
        n, u = divmod(t, T)
        kind = ["metal", "red", "black"][int(n) % 3]
        i = dict(B1=0, B3=0, B2=0, B6=0, B4=0, S1B1=1, S1B2=0, B7=1, S1=0, S2=1, S3=0, S4=1, S0=1)
        o = dict(Q_retract=0, H1=1, H2=0, H3=0)
        run = 0.3 < u < 8.6
        if u < 0.9: i["B1"] = 1
        if 4.6 < u < (6.6 if kind != "black" else 7.8):
            i["B3"] = 1
            i["B2"] = int(kind == "metal")
            i["B6"] = int(kind in ("metal", "red"))
        if kind != "black":
            if 5.5 < u < 6.9: o["Q_retract"] = 1
            if 5.6 < u < 7.0: i["S1B1"] = 0
            if 5.75 < u < 6.95: i["S1B2"] = 1
            if 7.6 < u < 8.2: i["B4"] = 1
        else:
            if 5.4 < u < 7.8: o["H3"] = int(t * 2) % 2
        f = 35 if run else 0
        w = round(f / 50 * 0x4000)
        d = dict(stw=0x047F if run else 0x047E, hsw=w, zsw=0xFB34 if run else 0xFB31, hiw=w, i=0.68 if run else 0)
        return {"in": i, "out": o, "drv": d}


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--map", default=str(Path(__file__).with_name("map.json")))
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--hz", type=float, default=20)
    a = ap.parse_args()
    src = DemoSource() if a.demo else S7Source(json.loads(Path(a.map).read_text()))
    clients = set()

    async def handler(ws):
        clients.add(ws)
        try:
            await ws.wait_closed()
        finally:
            clients.discard(ws)

    async with websockets.serve(handler, "127.0.0.1", a.port):
        print(f"gateway on ws://localhost:{a.port}  source={'demo' if a.demo else 'S7 ' + src.cfg['plc']['ip']}")
        err = None
        while True:
            try:
                msg = src.read()
                msg["ts"] = time.time()
                if err:
                    print("PLC link restored"); err = None
            except Exception as e:  # keep serving; tell the page the PLC is unreachable
                if str(e) != err:
                    print("PLC read failed:", e); err = str(e)
                msg = {"error": str(e), "ts": time.time()}
                await asyncio.sleep(1)
            if clients:
                websockets.broadcast(clients, json.dumps(msg))
            await asyncio.sleep(1 / a.hz)


if __name__ == "__main__":
    asyncio.run(main())
