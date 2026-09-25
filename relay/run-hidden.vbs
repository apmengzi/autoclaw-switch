' 以隐藏方式启动 relay/server.mjs（无 conhost 闪窗，脱离调用方进程树存活）。
' node 的查找顺序：AutoClaw 自带 node -> 系统 PATH。
' wscript.exe //B run-hidden.vbs
Option Explicit

Dim ws, fso, node, serverPath, relayDir, cand

Set ws  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

relayDir = fso.GetParentFolderName(WScript.ScriptFullName)
serverPath = relayDir & "\server.mjs"

If Not fso.FileExists(serverPath) Then WScript.Quit 1

' 1) AutoClaw 自带 node（常见安装位置）
Dim roots(3)
roots(0) = "D:\AutoClaw\resources\node\node.exe"
roots(1) = "C:\AutoClaw\resources\node\node.exe"
roots(2) = "C:\Program Files\AutoClaw\resources\node\node.exe"
roots(3) = ws.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\AutoClaw\resources\node\node.exe"
node = ""
For Each cand In roots
    If fso.FileExists(cand) Then
        node = cand
        Exit For
    End If
Next

' 2) 系统 PATH
If node = "" Then node = "node"

ws.CurrentDirectory = relayDir
ws.Run "cmd /c """"" & node & """ """ & serverPath & """ 1>>""" & relayDir & "\relay.log"" 2>>""" & relayDir & "\relay.err.log""""", 0, False
