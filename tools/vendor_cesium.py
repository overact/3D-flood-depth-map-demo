"""Reproduce the pinned browser-only Cesium runtime and its file hashes."""
import base64
import hashlib
import io
import json
import tarfile
from pathlib import Path
from urllib.request import urlopen

VERSION = "1.145.0"
URL = f"https://registry.npmjs.org/cesium/-/cesium-{VERSION}.tgz"
INTEGRITY = "6Azix8b5LPpoVSx8XQ6zPztpluJVmq+CEO3W2rOWxtc6bri6Nc9MvCYhKmTW1LAEwfisV7yzNgfulCXw9842+g=="
ROOT = Path(__file__).resolve().parents[1] / "vendor/cesium"


def main():
    with urlopen(URL, timeout=120) as response:
        archive = response.read()
    if base64.b64encode(hashlib.sha512(archive).digest()).decode() != INTEGRITY:
        raise ValueError("Cesium package integrity mismatch")
    hashes = {}
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        for member in source.getmembers():
            if not member.isfile():
                continue
            if member.name.startswith("package/Build/Cesium/"):
                relative = member.name[len("package/Build/Cesium/"):]
            elif member.name in ["package/LICENSE.md", "package/ThirdParty.json"]:
                relative = member.name[len("package/"):]
            else:
                continue
            if relative in ["index.js", "index.cjs"]:
                continue
            if Path(relative).is_absolute() or ".." in Path(relative).parts:
                raise ValueError("Unsafe archive path")
            content = source.extractfile(member).read()
            target = ROOT / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            hashes[relative] = hashlib.sha256(content).hexdigest()
    manifest = {"package":"cesium", "version":VERSION, "source":URL,
        "integrity":"sha512-" + INTEGRITY,
        "selection":"Browser Build/Cesium runtime, workers, assets, widgets, third-party notices; Node/ESM duplicate bundles omitted",
        "sha256":hashes}
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Verified and installed Cesium {VERSION}: {len(hashes)} runtime files")


if __name__ == "__main__":
    main()
