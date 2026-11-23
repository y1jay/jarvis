// 화면이 꺼져도(맥북 덮개 닫고 외장 모니터만 쓰는 상태 포함) 계속 듣기:
// - 시스템이 잠들지 않게 유지 (화면 끄기는 허용)
// - 호출되면 꺼진 화면을 깨운다
// - 덮개 닫힘(클램쉘) 감지 → 내장 마이크가 하드웨어적으로 꺼진다는 걸 알려 주기 위해
import { execFile, spawn } from 'node:child_process'
import { powerSaveBlocker } from 'electron'

/** `ioreg -r -k AppleClamshellState` 출력에서 덮개 닫힘 여부 */
export function parseClamshell(ioregOut: string): boolean {
  return /"AppleClamshellState"\s*=\s*Yes/.test(ioregOut)
}

export function isClamshell(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile('ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '4'], { timeout: 5000 }, (_e, out) => resolve(parseClamshell(String(out ?? ''))))
  })
}

export class KeepAwake {
  private id: number | null = null

  /** 시스템 잠자기 방지 (화면 끄기는 허용) — 항상 듣기 중일 때만 */
  set(on: boolean): void {
    if (on && this.id === null) this.id = powerSaveBlocker.start('prevent-app-suspension')
    else if (!on && this.id !== null) {
      powerSaveBlocker.stop(this.id)
      this.id = null
    }
  }

  get active(): boolean {
    return this.id !== null && powerSaveBlocker.isStarted(this.id)
  }
}

/** 꺼진(잠자는) 화면 깨우기 */
export function wakeDisplay(): void {
  if (process.platform === 'darwin') {
    // 사용자 활동이 있었던 것으로 알려 디스플레이를 켠다
    const p = spawn('caffeinate', ['-u', '-t', '3'], { stdio: 'ignore', detached: true })
    p.unref()
  } else if (process.platform === 'win32') {
    // 마우스를 제자리에서 0px 움직인 입력을 보내 모니터를 깨운다 (커서 위치는 그대로)
    const ps = `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e);' -Name U -Namespace W; [W.U]::mouse_event(0x0001,0,0,0,0)`
    const p = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore', windowsHide: true, detached: true })
    p.unref()
  }
}
