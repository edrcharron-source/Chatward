# Builds chatward-app-audio.exe (see main.cpp) into packages/client/build, where the installer picks it up.
# Needs Visual Studio's C++ tools (GitHub's Windows runners have them).
$ErrorActionPreference = 'Stop'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Visual Studio C++ tools not found' }
$src = Join-Path $PSScriptRoot 'main.cpp'
$out = Join-Path $PSScriptRoot '..\..\build\chatward-app-audio.exe'
$obj = Join-Path $env:TEMP 'chatward-app-audio.obj'
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
cmd /c "`"$vcvars`" >nul && cl /nologo /O2 /EHsc /W4 /std:c++17 /DUNICODE /D_UNICODE /MT `"$src`" /Fo`"$obj`" /Fe`"$out`" /link mmdevapi.lib ole32.lib user32.lib"
if ($LASTEXITCODE -ne 0) { throw 'chatward-app-audio.exe did not build' }
Write-Host "Built $out"
