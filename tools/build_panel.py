"""Build the Clearway MSFS toolbar panel into a Community-folder package.

Requirements: the free MSFS SDK (install it from MSFS Developer Mode). The SDK's
fspackagetool briefly starts Microsoft Flight Simulator to compile the panel
definition (.spb) - that's normal; it closes again when the build is done.
MSFS must be closed before running it, otherwise the tool exits without building.
Alternatively, with MSFS open in Developer Mode: Tools > Project Editor > Open project
(msfs-panel/clearway-panel-project.xml) > Build All, then run this script with --assemble.

Usage:
    python tools/build_panel.py              build into dist/clearway-panel
    python tools/build_panel.py --install    build and copy into your Community folder
    python tools/build_panel.py --assemble   skip the SDK step (re-use the last compiled .spb)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PANEL = ROOT / "msfs-panel"
DIST = ROOT / "dist" / "clearway-panel"
PACKAGE_NAME = "clearway-panel"
VERSION = "1.5.0"
# MSFS package manifests use X.Y.Z; a fourth part (hotfix) is dropped there
MANIFEST_VERSION = ".".join(VERSION.split(".")[:3])


def find_sdk_tool() -> Path:
    candidates = [os.environ.get("MSFS_SDK", ""), r"C:\MSFS SDK", os.environ.get("MSFS2024_SDK", "")]
    for base in candidates:
        if base:
            tool = Path(base) / "Tools" / "bin" / "fspackagetool.exe"
            if tool.exists():
                return tool
    sys.exit("fspackagetool.exe not found. Install the MSFS SDK (Developer Mode > Help > SDK Installer).")


def compile_spb() -> Path:
    tool = find_sdk_tool()
    build = PANEL / "build"
    if build.exists():
        shutil.rmtree(build)
    print(f"Running {tool.name} (MSFS will open briefly to compile the panel)...")
    result = subprocess.run([str(tool), str(PANEL / "clearway-panel-project.xml")], cwd=PANEL)
    if result.returncode != 0:
        sys.exit(f"fspackagetool failed with exit code {result.returncode}. See {build / '_temp'} for logs.")
    spbs = list(build.rglob("*.spb"))
    if not spbs:
        sys.exit("Build finished but no .spb file was produced. Close MSFS and try again "
                 "(the tool can't build while the sim is already running).")
    cache = PANEL / "compiled"
    cache.mkdir(exist_ok=True)
    shutil.copy2(spbs[0], cache / "clearway-panel.spb")
    return cache / "clearway-panel.spb"


# (1.5.0) panel frame variants. MSFS gives a toolbar panel the frame its definition asks for (a % of the UI height,
# pinned to the right) and doesn't fit it to the screen, so ultrawide screens need their own definition:
#   16x9  defaultWidth="178"  (msfs-panel/PackageSources/clearway-panel.xml, compiled/clearway-panel.spb)
#   21x9  defaultWidth="237"  -> compiled/clearway-panel-21x9.spb   (2560x1080 = 2.37, 3440x1440 = 2.39)
#   32x9  defaultWidth="355"  -> compiled/clearway-panel-32x9.spb   (5120x1440 = 3.56)
# To make one: set defaultWidth in the XML, build (this script without --assemble, or Dev Mode > Project Editor >
# Build All), copy the built .spb to the name above, then put defaultWidth back to 178.
VARIANTS = {"16x9": "clearway-panel.spb", "21x9": "clearway-panel-21x9.spb", "32x9": "clearway-panel-32x9.spb"}


def sync_radar() -> None:
    """The radar's code has one source, companion/web/radar (also used by its browser test page)."""
    src = ROOT / "companion" / "web" / "radar"
    dst = PANEL / "html_ui" / "InGamePanels" / "ClearwayPanel"
    for name in ("radar.js", "radar.css"):
        shutil.copy2(src / name, dst / name)


def win_filetime(path: Path) -> int:
    return int(path.stat().st_mtime * 10_000_000) + 116444736000000000


def assemble(spb: Path) -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(PANEL / "html_ui", DIST / "html_ui")
    # older sim versions look for toolbar icons here
    icon = PANEL / "html_ui" / "icons" / "toolbar" / "ICON_TOOLBAR_CLEARWAY.svg"
    legacy = DIST / "html_ui" / "Textures" / "Menu" / "toolbar"
    legacy.mkdir(parents=True, exist_ok=True)
    shutil.copy2(icon, legacy / icon.name)
    (DIST / "InGamePanels").mkdir(parents=True)
    shutil.copy2(spb, DIST / "InGamePanels" / "clearway-panel.spb")

    manifest = {
        "dependencies": [
            {"name": "fs-base-propdefs", "package_version": "0.1.2"},
            {"name": "fs-base-ui", "package_version": "0.1.10"},
        ],
        "content_type": "",
        "title": "Clearway CPDLC Panel",
        "manufacturer": "Clearway",
        "creator": "Clearway contributors",
        "package_version": MANIFEST_VERSION,
        "minimum_game_version": "1.35.21",
        "release_notes": {"neutral": {"LastUpdate": "", "OlderHistory": ""}},
        "total_package_size": "0",
    }
    files = sorted(p for p in DIST.rglob("*") if p.is_file())
    layout = {"content": [
        {"path": p.relative_to(DIST).as_posix(), "size": p.stat().st_size, "date": win_filetime(p)} for p in files
    ]}
    (DIST / "layout.json").write_text(json.dumps(layout, indent=2))
    total = sum(p.stat().st_size for p in files) + (DIST / "layout.json").stat().st_size
    manifest["total_package_size"] = f"{total:020d}"
    (DIST / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"Package ready: {DIST}")


def community_folder() -> Path | None:
    for cfg in [
        Path(os.environ.get("LOCALAPPDATA", "")) / "Packages" / "Microsoft.FlightSimulator_8wekyb3d8bbwe" / "LocalCache" / "UserCfg.opt",
        Path(os.environ.get("APPDATA", "")) / "Microsoft Flight Simulator" / "UserCfg.opt",
    ]:
        if cfg.exists():
            m = re.search(r'InstalledPackagesPath\s+"([^"]+)"', cfg.read_text(errors="ignore"))
            if m:
                return Path(m.group(1)) / "Community"
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--install", action="store_true", help="copy the package into the MSFS Community folder")
    ap.add_argument("--assemble", action="store_true", help="re-use msfs-panel/compiled/clearway-panel.spb")
    # (1.5.0) ultrawide versions: the same package with a wider panel frame (compiled separately, see VARIANTS)
    ap.add_argument("--variant", choices=sorted(VARIANTS), default="16x9", help="panel frame: 16x9 (default), 21x9 or 32x9")
    args = ap.parse_args()

    sync_radar()
    if args.variant != "16x9":
        spb = PANEL / "compiled" / VARIANTS[args.variant]
        if not spb.exists():
            sys.exit(f"Missing {spb}: compile the {args.variant} panel definition first (see VARIANTS in build_panel.py).")
        assemble(spb)
        return
    spb = PANEL / "compiled" / "clearway-panel.spb"
    if args.assemble and not spb.exists():
        # pick up a build made in the sim (Dev Mode > Project Editor > Build All)
        built = list((PANEL / "build").rglob("*.spb")) if (PANEL / "build").exists() else []
        if built:
            spb.parent.mkdir(exist_ok=True)
            shutil.copy2(built[0], spb)
    if not args.assemble or not spb.exists():
        spb = compile_spb()
    assemble(spb)

    if args.install:
        community = community_folder()
        if not community:
            sys.exit("Couldn't find your Community folder; copy dist/clearway-panel there manually.")
        target = community / PACKAGE_NAME
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(DIST, target)
        print(f"Installed to {target}. Restart MSFS if it's running.")


if __name__ == "__main__":
    t = time.time()
    main()
    print(f"Done in {time.time() - t:.0f}s")
