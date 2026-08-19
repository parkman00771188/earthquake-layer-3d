' Launch auto_update_run.bat with no console window. The Task Scheduler
' entry points here so the half-hourly refresh never flashes a window.
Dim sh, full, root
Set sh = CreateObject("WScript.Shell")
full = WScript.ScriptFullName
root = Left(full, InStrRev(full, "\scripts\"))
sh.Run """" & root & "auto_update_run.bat""", 0, True
