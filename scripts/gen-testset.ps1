# 生成准确率测试集：用系统 TTS 合成英语语音，同时保存精确的标准答案文本
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$dir = "E:/SY/project/Real-timeTranslation/.build-logs/acctest"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$cases = @(
  "Hello everyone, welcome to today's meeting.",
  "The train leaves at seven forty five and arrives at nine thirty.",
  "Microsoft released a new version of Windows in Seattle last month.",
  "Artificial intelligence is transforming how we work and communicate.",
  "Although the weather was terrible, we decided to continue our journey."
)

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoiceByHints(
  [System.Speech.Synthesis.VoiceGender]::NotSet,
  [System.Speech.Synthesis.VoiceAge]::NotSet,
  0,
  [System.Globalization.CultureInfo]::new("en-US")
)

for ($i = 0; $i -lt $cases.Count; $i++) {
  $id = "{0:d2}" -f ($i + 1)
  $wav = Join-Path $dir "$id.wav"
  $synth.SetOutputToWaveFile($wav)
  $synth.Speak($cases[$i])
  Set-Content -Path (Join-Path $dir "$id.txt") -Value $cases[$i] -Encoding UTF8
}
$synth.Dispose()

Get-ChildItem $dir | Select-Object Name, Length | Format-Table | Out-String
