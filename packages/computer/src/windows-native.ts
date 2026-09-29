/**
 * C# helper compiled on demand inside PowerShell (`Add-Type`). It wraps the handful of Win32 calls Allaya needs.
 * This text is a CONSTANT: no user or model input is ever interpolated into it — arguments travel separately, as
 * JSON in an environment variable, and are parsed by `ConvertFrom-Json` (see `windows-scripts.ts`).
 */
export const NATIVE_CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Allaya {
  public class WinInfo {
    public long Handle; public string Title; public uint Pid;
    public int X; public int Y; public int W; public int H;
    public bool Iconic; public bool Focused; public bool Elevated;
  }

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }

  public static class Native {
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int value, int size);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);

    const int GWL_EXSTYLE = -20;
    const int WS_EX_TOOLWINDOW = 0x80;
    const int DWMWA_CLOAKED = 14;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint WM_CLOSE = 0x0010;
    const int SW_RESTORE = 9;
    const uint KEYEVENTF_KEYUP = 0x2;
    const uint KEYEVENTF_UNICODE = 0x4;
    const uint KEYEVENTF_EXTENDEDKEY = 0x1;

    public static void EnableDpiAwareness() { try { SetProcessDPIAware(); } catch (Exception) { } }

    public static List<WinInfo> ListWindows() {
      var found = new List<WinInfo>();
      IntPtr foreground = GetForegroundWindow();
      EnumWindows(delegate (IntPtr h, IntPtr l) {
        if (!IsWindowVisible(h)) return true;
        if ((GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;
        int cloaked; if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return true;
        int len = GetWindowTextLength(h);
        if (len == 0) return true;
        var sb = new StringBuilder(len + 1); GetWindowText(h, sb, sb.Capacity);
        uint pid; GetWindowThreadProcessId(h, out pid);
        RECT r; GetWindowRect(h, out r);
        // A process we cannot even query is running with more rights than we have: treat it as elevated.
        IntPtr proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        bool elevated = proc == IntPtr.Zero; if (!elevated) CloseHandle(proc);
        found.Add(new WinInfo { Handle = h.ToInt64(), Title = sb.ToString(), Pid = pid, X = r.Left, Y = r.Top, W = r.Right - r.Left, H = r.Bottom - r.Top, Iconic = IsIconic(h), Focused = h == foreground, Elevated = elevated });
        return true;
      }, IntPtr.Zero);
      return found;
    }

    public static bool Focus(long handle) {
      IntPtr h = new IntPtr(handle);
      if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
      // Windows only lets the foreground process raise windows; a synthetic Alt press lifts that restriction.
      keybd_event(0x12, 0, 0, UIntPtr.Zero);
      bool ok = SetForegroundWindow(h);
      keybd_event(0x12, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
      return ok;
    }

    public static bool Close(long handle) { return PostMessage(new IntPtr(handle), WM_CLOSE, IntPtr.Zero, IntPtr.Zero); }

    public static void Move(int x, int y) { SetCursorPos(x, y); }

    public static void Click(int x, int y, string button, int count) {
      SetCursorPos(x, y);
      Thread.Sleep(30);
      uint down = button == "right" ? 0x8u : button == "middle" ? 0x20u : 0x2u;
      uint up = button == "right" ? 0x10u : button == "middle" ? 0x40u : 0x4u;
      for (int i = 0; i < count; i++) {
        mouse_event(down, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(20);
        mouse_event(up, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(60);
      }
    }

    public static void Scroll(int delta) { mouse_event(0x800, 0, 0, delta, UIntPtr.Zero); }

    static INPUT Key(ushort vk, ushort scan, uint flags) {
      var input = new INPUT(); input.type = 1;
      input.U.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
      return input;
    }

    static void Send(List<INPUT> inputs) {
      int size = Marshal.SizeOf(typeof(INPUT));
      for (int i = 0; i < inputs.Count; i += 64) {
        int n = Math.Min(64, inputs.Count - i);
        var batch = inputs.GetRange(i, n).ToArray();
        SendInput((uint)n, batch, size);
        Thread.Sleep(8);
      }
    }

    /// Types text as Unicode characters, so Bengali (and everything else) works regardless of keyboard layout.
    public static void TypeText(string text) {
      var inputs = new List<INPUT>();
      foreach (char c in text) {
        if (c == '\r') continue;
        if (c == '\n') { inputs.Add(Key(0x0D, 0, 0)); inputs.Add(Key(0x0D, 0, KEYEVENTF_KEYUP)); continue; }
        if (c == '\t') { inputs.Add(Key(0x09, 0, 0)); inputs.Add(Key(0x09, 0, KEYEVENTF_KEYUP)); continue; }
        inputs.Add(Key(0, c, KEYEVENTF_UNICODE));
        inputs.Add(Key(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
      }
      Send(inputs);
    }

    static bool IsExtended(ushort vk) {
      return vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24 || vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28 || vk == 0x2D || vk == 0x2E;
    }

    /// Presses modifiers, then the key, then releases in reverse order.
    public static void Chord(int[] modifiers, int key) {
      var inputs = new List<INPUT>();
      foreach (int m in modifiers) inputs.Add(Key((ushort)m, 0, 0));
      uint ext = IsExtended((ushort)key) ? KEYEVENTF_EXTENDEDKEY : 0u;
      inputs.Add(Key((ushort)key, 0, ext));
      inputs.Add(Key((ushort)key, 0, ext | KEYEVENTF_KEYUP));
      for (int i = modifiers.Length - 1; i >= 0; i--) inputs.Add(Key((ushort)modifiers[i], 0, KEYEVENTF_KEYUP));
      Send(inputs);
    }
  }
}
`;
