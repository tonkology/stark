# STARK twin gateway (Layer 2)

Reads the MT AC station's S7-300 and streams its I/O to the twin page, so the twin mirrors the real station.
It is read-only: it never writes to the PLC.

## Try it without a PLC

```
pip install -r requirements.txt
python gateway.py --demo
```

Open https://stark-91dfe.web.app/twin in Chrome on the same computer, go to the **Drive** tab and press **Connect**.

## Connect the real station

1. **Hardware.** The CPU 313C-2DP has no Ethernet port. Add one of:
   - a CP 343-1 (Lean) Ethernet module on the S7-300 rack, or
   - an MPI/PROFIBUS-to-Ethernet adapter that supports S7 communication over TCP (ISO-on-TCP, port 102).
2. **Addresses.** Edit `map.json`: set the PLC IP address and replace every address with the one from the station's wiring list / STEP 7 symbol table. The addresses shipped here are placeholders.
3. **Run.** `python gateway.py` on a lab PC on the same network as the PLC, then Connect from the twin page on that PC.

## Status

- Tested: reading inputs, outputs and drive words from a simulated S7 server, and the page's live view with `--demo`.
- Not tested: a real S7-300. The drive words (PIW/PQW 256+) are peripheral addresses, and whether they can be read this way depends on the CPU's process-image size. If they read as zero, the PLC program has to copy them to a data block, and the gateway needs data-block reading added (it only reads I and Q addresses today).
