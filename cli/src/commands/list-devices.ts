import { spawnSync } from 'node:child_process';
import { IS_WINDOWS, IS_LINUX, IS_MACOS } from '../platform';

/**
 * 利用可能な録音 (マイク) デバイスを OS ごとの最適な方法で列挙する。
 * 結果から好みのデバイス名を見つけて `start --device "<name>"` に渡してもらう。
 */
export function runListDevices(): void {
  console.log('\n🎙  音声入力デバイス一覧');
  console.log('─'.repeat(60));

  if (IS_WINDOWS) {
    listWindows();
  } else if (IS_LINUX) {
    listLinux();
  } else if (IS_MACOS) {
    listMacOs();
  } else {
    console.log(`未対応の OS: ${process.platform}`);
  }
}

function listWindows(): void {
  // Get-PnpDevice -Class AudioEndpoint の InstanceId に MMDevice の DataFlow が埋まっている。
  //   {0.0.1.00000000} = Capture (入力 = マイク)
  //   {0.0.0.00000000} = Render  (出力 = スピーカー等)
  // これで入力デバイスのみを正確に絞り込めるので、それを優先表示する。
  const ps = `
    $ErrorActionPreference = 'SilentlyContinue'
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
    $all = Get-PnpDevice -Class AudioEndpoint -Status OK | Sort-Object FriendlyName
    if (-not $all) {
      Write-Host '(オーディオエンドポイントが見つかりません)'
      exit
    }

    $inputs  = $all | Where-Object { $_.InstanceId -match '\\\\{0\\.0\\.1\\.' }
    $outputs = $all | Where-Object { $_.InstanceId -match '\\\\{0\\.0\\.0\\.' }

    Write-Host '== 録音デバイス (これを --device に渡してください) =='
    if ($inputs) {
      $inputs | ForEach-Object { Write-Host ("  [mic] " + $_.FriendlyName) }
    } else {
      Write-Host '  (見つかりません — デバイスマネージャで確認してください)'
    }
    Write-Host ''
    Write-Host '== 参考: 再生デバイス (録音には使えません) =='
    if ($outputs) {
      $outputs | ForEach-Object { Write-Host ("  [spk] " + $_.FriendlyName) }
    }
    Write-Host ''
    Write-Host '== Windows の既定の録音デバイス =='
    $defaultIn = Get-CimInstance -Namespace 'root\\cimv2' -ClassName Win32_PnPEntity -Filter "PNPClass='AudioEndpoint' AND Status='OK'" | Select-Object -First 1
    if ($defaultIn) { Write-Host ("  (Windows 設定 → システム → サウンド → 入力 で確認できます)") }
  `;
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    stdio: 'inherit',
    shell: false,
  });

  console.log('\n' + '─'.repeat(60));
  console.log('使い方:');
  console.log('  npm run cli -- start --device "ヘッドセット (UGREEN HiTune Max5c)"');
  console.log('  ※ [mic] の後ろの名前をそのままコピーしてください');
  console.log('\n録音されている音声が変・別の音源 (BGM 等) が録音される場合:');
  console.log('  1. Windows 設定 → システム → サウンド → 入力 で既定のマイクを確認');
  console.log('  2. それでも直らなければ上記から正しいマイクを選んで --device で指定');
}

function listLinux(): void {
  const r = spawnSync('arecord', ['-l'], { stdio: 'inherit', shell: false });
  if (r.status !== 0) {
    console.log('\n(arecord が見つかりません。sudo apt install alsa-utils でインストールしてください)');
    return;
  }
  console.log('\n' + '─'.repeat(60));
  console.log('使い方 (card N, device M を指定):');
  console.log('  npm run cli -- start --device hw:1,0     # card 1, device 0 の場合');
}

function listMacOs(): void {
  // system_profiler の出力は冗長だが網羅的
  const r = spawnSync('system_profiler', ['SPAudioDataType'], { stdio: 'inherit', shell: false });
  if (r.status !== 0) {
    console.log('\n(system_profiler の実行に失敗しました)');
  }
  console.log('\n' + '─'.repeat(60));
  console.log('使い方 (Input セクションのデバイス名を指定):');
  console.log('  npm run cli -- start --device "Built-in Microphone"');
  console.log('  npm run cli -- start --device "MacBook Proのマイク"');
}
