# -*- mode: python ; coding: utf-8 -*-
import os


a = Analysis(
    ['a_switch_app.py'],
    pathex=[],
    binaries=[],
    datas=[('relay', 'relay')],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # 只用 Edge WebView2 后端。不排掉这些，pywebview 的 hook 会把整机 Qt 拖进单文件 exe
    # （Qt5WebEngineCore 单独 112MB，产物从 19MB 变 148MB）。
    excludes=['PyQt5', 'PyQt6', 'PySide2', 'PySide6', 'tkinter'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='A-SWITCH',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # 窗口/任务栏图标不用额外打进去：pywebview 的 winforms 后端会 ExtractIconW(exe, 0)
    icon=os.path.join(SPECPATH, 'assets', 'aswitch.ico'),
    uac_admin=True,
)
