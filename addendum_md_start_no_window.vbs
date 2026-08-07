' Double-click to start Addendum.md WITHOUT any console window.
' A browser tab opens automatically.
'
' To STOP it later: double-click "Addendum.md_stop.cmd" in this folder.
' (If nothing happens when you run this, Node.js may not be installed --
'  run start.cmd once, which checks for Node and tells you where to get it.)
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
dir  = fso.GetParentFolderName(WScript.ScriptFullName)
' Passed empty, the server keeps its saved root, so the folder picked in the UI
' survives a restart. Seed a default only on a first launch (no config.json).
root = ""
If Not fso.FileExists(dir & "\config.json") Then
  root = fso.GetParentFolderName(fso.GetParentFolderName(dir))   ' the repo (two levels up)
End If
port = "8888"
' 0 = hidden window, False = don't wait. Running node directly (not start.cmd)
' means killing the server via Addendum.md_stop.cmd leaves nothing behind.
sh.Run "cmd /c node """ & dir & "\server.js"" """ & root & """ " & port, 0, False
