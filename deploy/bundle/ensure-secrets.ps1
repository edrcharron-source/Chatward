# Fills LIVEKIT_API_KEY and LIVEKIT_API_SECRET in .env with random values when they are blank or still the old public defaults.
# Also fills SETUP_CODE (the code the first account must enter) once, when it is blank, and shows it.
# Called by start-server.bat. Existing values that are not defaults are left alone.
$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot '.env'
$text = [IO.File]::ReadAllText($envFile)

function New-RandomHex([int]$bytes) {
  $buffer = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  return -join ($buffer | ForEach-Object { $_.ToString('x2') })
}

$generated = @{
  'LIVEKIT_API_KEY'    = 'API' + (New-RandomHex 6)
  'LIVEKIT_API_SECRET' = New-RandomHex 32
}

foreach ($name in $generated.Keys) {
  $current = if ($text -match "(?m)^$name=(.*)$") { $Matches[1].Trim() } else { '' }
  if ($current -ne '' -and $current -ne 'devkey' -and $current -ne 'secret') { continue }

  $line = "$name=$($generated[$name])"
  if ($text -match "(?m)^$name=.*\r?$") {
    $text = $text -replace "(?m)^$name=.*\r?$", $line
  } else {
    if ($text.Length -gt 0 -and -not $text.EndsWith("`n")) { $text += "`r`n" }
    $text += "$line`r`n"
  }
}

# Setup code: 12 random characters in the look-alike-free alphabet the server uses, shown as XXXX-XXXX-XXXX.
$currentSetup = if ($text -match '(?m)^SETUP_CODE=(.*)$') { $Matches[1].Trim() } else { '' }
if ($currentSetup -eq '') {
  $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  $bytes = New-Object byte[] 12
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $chars = -join ($bytes | ForEach-Object { $alphabet[$_ % 32] })
  $setupCode = "$($chars.Substring(0, 4))-$($chars.Substring(4, 4))-$($chars.Substring(8, 4))"
  if ($text -match '(?m)^SETUP_CODE=.*\r?$') {
    $text = $text -replace '(?m)^SETUP_CODE=.*\r?$', "SETUP_CODE=$setupCode"
  } else {
    if ($text.Length -gt 0 -and -not $text.EndsWith("`n")) { $text += "`r`n" }
    $text += "SETUP_CODE=$setupCode`r`n"
  }
  Write-Host ''
  Write-Host "Setup code for your first account: $setupCode"
  Write-Host 'Enter it on the Register screen when you create the first account. It is also saved as SETUP_CODE in .env.'
}

[IO.File]::WriteAllText($envFile, $text)
