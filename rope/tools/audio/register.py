"""Register a versioned audition set through the game's local Sounds API."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import urllib.request

HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default="http://127.0.0.1:3100")
    parser.add_argument("--local-preview", action="store_true", help="Allow missing licence metadata for user-provided local auditions; asset validation will still block publishing")
    versions = sorted({c["name"].rsplit("-", 1)[-1] for c in json.loads((HERE / "out/manifest.json").read_text())["candidates"]})
    parser.add_argument("--version", choices=versions, default="v2")
    args = parser.parse_args()
    base = args.server.rstrip("/") + "/api/sounds"

    def request(path="", method="GET", body=None, raw=False):
        data = body if raw else json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "audio/wav" if raw else "application/json"}
        with urllib.request.urlopen(urllib.request.Request(base + path, data=data, headers=headers, method=method), timeout=20) as response:
            return json.load(response)

    current = request()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = HERE / "out" / f"bank-before-{args.version}-{stamp}.json"
    backup.write_text(json.dumps(current, indent=2) + "\n")
    manifest = json.loads((HERE / "out/manifest.json").read_text())
    selected = [c for c in manifest["candidates"] if c["name"].endswith("-" + args.version)]
    by_slot = {}
    for c in selected:
        slot = c.get("slot", c["event"])
        # Legacy foley candidates predate the explicit slot field.
        if c["name"].startswith("land-chain-foley-"):
            slot = "land.metal"
        slots = [slot] if c["name"].startswith("land-chain-foley-") else c.get("slots", [slot])
        for key in slots:
            by_slot.setdefault(key, []).append(c["name"])
    if not selected or any(slot.split(".")[0] not in {"land", "land-light", "land-medium", "land-heavy", "loop-hit", "ball-settle", "attach", "wind", "deploy", "slack", "taut", "creak", "wrap", "roll"} for slot in by_slot):
        raise ValueError("Select a version with landing or chain sound candidates")
    for c in selected:
        if not all(c.get(field, "").strip() for field in ["source", "author", "license"]) and not args.local_preview:
            raise ValueError(f"{c['name']} has incomplete provenance. Use --local-preview only for a local audition.")
    keys = {}
    for c in selected:
        file = HERE / "out" / c["file"]
        uploaded = request(f"?name={c['name']}.wav", "POST", file.read_bytes(), raw=True)
        key = uploaded["key"]
        request(f"/assets/{key}", "PATCH", {field: c[field] for field in ["source", "author", "license"]})
        keys[c["name"]] = key
    bank = current["bank"]
    old_keys = {key for slot in by_slot for key in bank["slots"].get(slot, {}).get("sounds", [])}
    if all(f"land-{strength}" in by_slot for strength in ["light", "medium", "heavy"]):
        # Replace the previous single-sound landing assignments when a complete
        # strength set is supplied. Keep their controls as an unassigned fallback.
        for slot, params in bank["slots"].items():
            if slot == "land" or slot.startswith("land."):
                old_keys.update(params.pop("sounds", []))
    for slot, names in by_slot.items():
        params = bank["slots"].setdefault(slot, {**bank["slots"].get(slot.split(".")[0], {})})
        params["sounds"] = [keys[n] for n in names]
        if slot != "roll":
            params["pitchJitter"] = 0 if slot in {"deploy", "slack", "creak", "loop-hit", "ball-settle"} else 0.4 if slot == "wind" else 0.25
    request("/bank", "PUT", bank)
    after = request()
    assert after["bank"] == bank, "Bank readback differs"
    assigned = {key for slot in bank["slots"].values() for key in slot.get("sounds", [])}
    # Old renders remain in out/ for A/B comparison. The shipping library only
    # retains sounds used by events, as required by the asset-store checks.
    for key in old_keys - assigned:
        request(f"/assets/{key}", "DELETE")
    for key in keys.values():
        asset = after["assets"][key]
        if not args.local_preview:
            assert all(asset[f] for f in ["source", "author", "license"])
        with urllib.request.urlopen(args.server.rstrip("/") + asset["file"], timeout=20) as response:
            assert response.status == 200
    print(f"Registered {len(keys)} sounds; verified bank and playable files. Backup: {backup}")
    if args.local_preview:
        print("Local preview: incomplete licence fields remain blank pending source details.")


if __name__ == "__main__":
    main()
