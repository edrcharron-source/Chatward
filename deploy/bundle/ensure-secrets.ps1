# Fills LIVEKIT_API_KEY and LIVEKIT_API_SECRET in .env with random values when they are blank or still the old public defaults.
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

[IO.File]::WriteAllText($envFile, $text)
