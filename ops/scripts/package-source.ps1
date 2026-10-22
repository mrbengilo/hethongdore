[CmdletBinding()]
param(
  [string]$ProjectRoot = (Join-Path $PSScriptRoot '..\..'),
  [string]$OutputDirectory = $env:TEMP
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectRoot).Path
$output = (Resolve-Path -LiteralPath $OutputDirectory).Path
$entries = @(
  '.gitattributes', '.gitignore',
  '.openai/hosting.json',
  'app', 'build', 'db', 'docs', 'drizzle', 'examples', 'ops', 'public',
  'scripts', 'tests', 'worker',
  'cloudflare-env.d.ts', 'drizzle.config.ts', 'eslint.config.mjs',
  'next-env.d.ts', 'next.config.ts', 'package.json', 'pnpm-lock.yaml',
  'pnpm-workspace.yaml', 'postcss.config.mjs', 'README.md', 'tsconfig.json',
  'vite.config.ts'
)

foreach ($entry in $entries) {
  if (-not (Test-Path -LiteralPath (Join-Path $project $entry))) {
    throw "Required release entry is missing: $entry"
  }
}

$pending = Join-Path $output ("dore-src-pending-{0}.tar.gz" -f [guid]::NewGuid().ToString('N'))
try {
  & tar.exe -C $project -czf $pending @entries
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the release archive.' }

  $manifest = @(& tar.exe -tzf $pending)
  if ($LASTEXITCODE -ne 0) { throw 'Could not read the archive manifest.' }

  $required = @('package.json', '.openai/hosting.json', 'ops/scripts/deploy.sh', 'build/sites-vite-plugin.ts')
  foreach ($entry in $required) {
    if ($manifest -notcontains $entry) { throw "Archive is missing: $entry" }
  }

  $forbidden = $manifest | Where-Object {
    $_ -match '(^|/)(\.git|node_modules|\.next|\.vinext|dist|\.vps-access|\.qa-[^/]*|\.codex-dev|\.wrangler|coverage|outputs)(/|$)' -or
    $_ -match '(^|/)\.openai/(?!hosting\.json$)' -or
    $_ -match '(^|/)\.env[^/]*$' -or
    $_ -match '(^|/)(Cookies|History|Login Data)$' -or
    $_ -match '(?i)(\.sqlite(?:-wal|-shm)?|\.pem|\.key|\.pfx|\.p12)$' -or
    $_ -match '(^|/)tsconfig\.tsbuildinfo$'
  }
  if ($forbidden) {
    throw "Forbidden files were found:`n$($forbidden -join "`n")"
  }

  $release = (Get-FileHash -LiteralPath $pending -Algorithm SHA256).Hash.ToLowerInvariant()
  $bundle = Join-Path $output "dore-src-$release.tar.gz"
  if (Test-Path -LiteralPath $bundle) { Remove-Item -LiteralPath $bundle -Force }
  Move-Item -LiteralPath $pending -Destination $bundle
  $checksum = "$bundle.sha256"
  [IO.File]::WriteAllText(
    $checksum,
    "$release  $(Split-Path -Leaf $bundle)`n",
    [Text.UTF8Encoding]::new($false)
  )

  [pscustomobject]@{
    Release = $release
    Bundle = $bundle
    Checksum = $checksum
    FileCount = $manifest.Count
  }
}
finally {
  if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force }
}
