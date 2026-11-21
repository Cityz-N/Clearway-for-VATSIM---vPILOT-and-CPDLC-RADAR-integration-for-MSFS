"""Windows process helpers (standard library only, ctypes): one Clearway at a time, and "is vPilot running?"."""
from __future__ import annotations

import ctypes
import os
from ctypes import wintypes as wt

_mutex = None          # kept for the life of the process: Windows frees it when Clearway exits


def claim_single_instance(name: str) -> bool:
    """True if this is the only Clearway with this name (port); False if another one already runs."""
    global _mutex
    if os.name != "nt":
        return True
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateMutexW.argtypes = [wt.LPVOID, wt.BOOL, wt.LPCWSTR]
    k32.CreateMutexW.restype = wt.HANDLE
    handle = k32.CreateMutexW(None, False, "Local\\" + name)
    if not handle:
        return True                       # can't tell: don't block Clearway from starting
    if ctypes.get_last_error() == 183:    # ERROR_ALREADY_EXISTS
        k32.CloseHandle(handle)
        return False
    _mutex = handle
    return True


class _PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
                ("th32DefaultHeapID", ctypes.c_void_p), ("th32ModuleID", wt.DWORD), ("cntThreads", wt.DWORD),
                ("th32ParentProcessID", wt.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wt.DWORD),
                ("szExeFile", ctypes.c_wchar * 260)]


def process_running(exe: str) -> bool | None:
    """Is a process with this file name (e.g. vPilot.exe) running? None if it can't be checked."""
    return None if os.name != "nt" else process_path(exe, want_path=False) is not None


def process_path(exe: str, want_path: bool = True) -> str | None:
    """Full path of a running process with this file name ("" if found but the path can't be read), else None."""
    if os.name != "nt":
        return None
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateToolhelp32Snapshot.argtypes = [wt.DWORD, wt.DWORD]
    k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
    k32.Process32FirstW.argtypes = [wt.HANDLE, ctypes.POINTER(_PROCESSENTRY32W)]
    k32.Process32NextW.argtypes = [wt.HANDLE, ctypes.POINTER(_PROCESSENTRY32W)]
    snap = k32.CreateToolhelp32Snapshot(0x2, 0)      # TH32CS_SNAPPROCESS
    if not snap or snap == wt.HANDLE(-1).value:
        return None
    try:
        entry = _PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(_PROCESSENTRY32W)
        ok = k32.Process32FirstW(snap, ctypes.byref(entry))
        want = exe.lower()
        while ok:
            if entry.szExeFile.lower() == want:
                return _image_path(k32, entry.th32ProcessID) if want_path else ""
            ok = k32.Process32NextW(snap, ctypes.byref(entry))
        return None
    finally:
        k32.CloseHandle(snap)


def _image_path(k32, pid: int) -> str:
    k32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
    k32.OpenProcess.restype = wt.HANDLE
    k32.QueryFullProcessImageNameW.argtypes = [wt.HANDLE, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD)]
    h = k32.OpenProcess(0x1000, False, pid)           # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wt.DWORD(1024)
        return buf.value if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)) else ""
    finally:
        k32.CloseHandle(h)


def find_vpilot(remembered: str = "") -> str | None:
    """Where vPilot.exe is installed: the path seen while it ran, the uninstall entry, or the usual folders."""
    override = os.environ.get("CLEARWAY_VPILOT_PATH")
    if override:
        return override if os.path.isfile(override) else None
    places = [remembered]
    if os.name == "nt":
        import winreg
        for root in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            for sub in (r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
                        r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"):
                try:
                    with winreg.OpenKey(root, sub) as key:
                        for i in range(winreg.QueryInfoKey(key)[0]):
                            try:
                                with winreg.OpenKey(key, winreg.EnumKey(key, i)) as app:
                                    if "vpilot" not in str(winreg.QueryValueEx(app, "DisplayName")[0]).lower():
                                        continue
                                    for value in ("InstallLocation", "DisplayIcon"):
                                        try:
                                            v = str(winreg.QueryValueEx(app, value)[0]).split(",")[0].strip('"')
                                        except OSError:
                                            continue
                                        places.append(v if v.lower().endswith(".exe") else os.path.join(v, "vPilot.exe"))
                            except OSError:
                                continue
                except OSError:
                    continue
    env = os.environ.get
    places += [r"C:\vPilot\vPilot.exe", os.path.join(env("LOCALAPPDATA", ""), "vPilot", "vPilot.exe"),
               os.path.join(env("ProgramFiles(x86)", ""), "vPilot", "vPilot.exe"),
               os.path.join(env("ProgramFiles", ""), "vPilot", "vPilot.exe")]
    return next((p for p in places if p and os.path.isfile(p)), None)


def launch_background(path: str) -> None:
    """Start a program minimized, without taking the focus away from the sim."""
    import subprocess
    si = subprocess.STARTUPINFO()
    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    si.wShowWindow = 7                                # SW_SHOWMINNOACTIVE
    subprocess.Popen([path], cwd=os.path.dirname(path), startupinfo=si, close_fds=True,
                     creationflags=0x00000008 | 0x00000200)   # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    pid_name = os.path.basename(path)
    import threading
    threading.Thread(target=_minimize_when_shown, args=(pid_name,), daemon=True).start()


def _minimize_when_shown(exe: str, wait: float = 30) -> None:
    """WPF apps (vPilot) ignore the start-minimized hint: minimize its window, without activating it, once it shows."""
    import time
    u32 = ctypes.WinDLL("user32", use_last_error=True)
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    proc = _pids(k32, exe)
    end = time.time() + wait
    done = set()
    enum_proc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    u32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
    u32.GetWindow.argtypes = [wt.HWND, wt.UINT]
    u32.GetWindow.restype = wt.HWND
    for fn in ("IsWindowVisible", "IsIconic"):
        getattr(u32, fn).argtypes = [wt.HWND]
    u32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]
    while time.time() < end:
        time.sleep(0.25)
        proc = proc or _pids(k32, exe)
        if not proc:
            continue

        def each(hwnd, _):
            pid = wt.DWORD()
            u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value in proc and u32.IsWindowVisible(hwnd) and not u32.IsIconic(hwnd) \
                    and not u32.GetWindow(hwnd, 4) and hwnd not in done:   # GW_OWNER: main windows only
                u32.ShowWindow(hwnd, 7)                                      # SW_SHOWMINNOACTIVE
                done.add(hwnd)
            return True
        u32.EnumWindows(enum_proc(each), 0)
        if done:
            return


def close_windows(exe: str) -> int:
    """Ask a program to close, like clicking its X: WM_CLOSE to its main windows (never a forced kill, so it can
    shut down normally, e.g. vPilot disconnects first). Returns how many windows were asked."""
    u32 = ctypes.WinDLL("user32", use_last_error=True)
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    procs = _pids(k32, exe)
    if not procs:
        return 0
    enum_proc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    u32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
    u32.GetWindow.argtypes = [wt.HWND, wt.UINT]
    u32.GetWindow.restype = wt.HWND
    u32.IsWindowVisible.argtypes = [wt.HWND]
    u32.PostMessageW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
    asked = []

    def each(hwnd, _):
        pid = wt.DWORD()
        u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in procs and u32.IsWindowVisible(hwnd) and not u32.GetWindow(hwnd, 4):   # main windows only
            if u32.PostMessageW(hwnd, 0x0010, 0, 0):                                         # WM_CLOSE
                asked.append(hwnd)
        return True
    u32.EnumWindows(enum_proc(each), 0)
    return len(asked)


def _pids(k32, exe: str) -> set:
    k32.CreateToolhelp32Snapshot.argtypes = [wt.DWORD, wt.DWORD]
    k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
    snap = k32.CreateToolhelp32Snapshot(0x2, 0)
    pids = set()
    try:
        entry = _PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(_PROCESSENTRY32W)
        ok = k32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            if entry.szExeFile.lower() == exe.lower():
                pids.add(entry.th32ProcessID)
            ok = k32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        k32.CloseHandle(snap)
    return pids
