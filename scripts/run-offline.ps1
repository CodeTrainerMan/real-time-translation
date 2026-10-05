# 对测试集逐条做离线识别 + 翻译，结果存成 json 供算准确率
cd "E:/SY/project/Real-timeTranslation"

$out = @()
foreach ($i in 1..5) {
  $id = "{0:d2}" -f $i
  $wav = ".build-logs\acctest\$id.wav"
  $ref = (Get-Content ".build-logs\acctest\$id.txt" -Raw).Trim()

  $raw = node scripts/probe.mjs $wav 2>&1 | Out-String
  $asr = ([regex]::Match($raw, '识别结果：(.*)')).Groups[1].Value.Trim()
  $mt = ([regex]::Match($raw, '翻译结果：(.*)')).Groups[1].Value.Trim()

  Write-Output "---- $id ----"
  Write-Output "REF: $ref"
  Write-Output "ASR: $asr"
  Write-Output "MT : $mt"

  $out += [pscustomobject]@{ id = $id; ref = $ref; asr = $asr; mt = $mt }
}
$out | ConvertTo-Json | Set-Content ".build-logs\acctest\offline.json" -Encoding UTF8
