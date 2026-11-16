// The OS's own folder window, opened on the computer T3 Orchestra runs on (the New board dialog's Browse buttons).
// A browser can't hand out a folder's path, so the server asks the desktop instead.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { onPath } from '../project-run/system.ts';

export class FolderPickerUnavailable extends Error {}
export class FolderPickerBusy extends Error {}

/** Closes a window nobody answered, so its process doesn't linger. */
const PICK_TIMEOUT_MS = 15 * 60_000;

// Windows PowerShell's FolderBrowserDialog is the old tree view; this is Explorer's own folder dialog
// (IFileOpenDialog with FOS_PICKFOLDERS). The interfaces stop at the last method used: COM only needs the
// vtable order up to there.
const WIN_PICKER_CS = String.raw`
using System;
using System.Runtime.InteropServices;

public static class T3OrchestraFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  class FileOpenDialog {}

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint count, IntPtr specs);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr bc, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint form, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }

  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int Left, Top, Right, Bottom; }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr bc, ref Guid iid, out IShellItem item);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint thread, uint to, bool attach);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint relation);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);

  /** Sharp text on scaled displays (per-monitor v2, else system-aware). */
  public static void DpiAware() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (EntryPointNotFoundException) {}
    SetProcessDPIAware();
  }

  /** Windows only lets the foreground app raise windows; borrowing its input queue for a moment gets around that. */
  public static void Raise(IntPtr window) {
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint me = GetCurrentThreadId();
    bool attached = fg != 0 && fg != me && AttachThreadInput(me, fg, true);
    BringWindowToTop(window);
    SetForegroundWindow(window);
    if (attached) AttachThreadInput(me, fg, false);
  }

  /** Centers the owner's dialog on its screen; false while the dialog isn't open yet. */
  static bool CenterPopup(IntPtr owner) {
    IntPtr popup = GetWindow(owner, 6); // GW_ENABLEDPOPUP
    RECT r;
    if (popup == IntPtr.Zero || popup == owner || !GetWindowRect(popup, out r)) return false;
    System.Drawing.Rectangle area = System.Windows.Forms.Screen.FromHandle(popup).WorkingArea;
    int w = r.Right - r.Left, h = r.Bottom - r.Top;
    SetWindowPos(popup, IntPtr.Zero, area.Left + Math.Max(0, (area.Width - w) / 2), area.Top + Math.Max(0, (area.Height - h) / 2), 0, 0, 0x0015); // NOSIZE | NOZORDER | NOACTIVATE
    Raise(popup);
    return true;
  }

  /** The chosen folder, or null when the window was closed. */
  public static string Pick(IntPtr owner, string title, string startIn) {
    IFileDialog d = (IFileDialog)new FileOpenDialog();
    uint options;
    d.GetOptions(out options);
    d.SetOptions(options | 0x20 | 0x40 | 0x800); // PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST
    if (!String.IsNullOrEmpty(title)) d.SetTitle(title);
    if (!String.IsNullOrEmpty(startIn)) {
      try {
        Guid iid = typeof(IShellItem).GUID;
        IShellItem start;
        SHCreateItemFromParsingName(startIn, IntPtr.Zero, ref iid, out start);
        d.SetFolder(start);
      } catch (Exception) {}
    }
    // The dialog opens with its corner on the (tiny) owner; a timer on this thread runs inside its modal loop.
    System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    int ticks = 0;
    timer.Interval = 15;
    timer.Tick += delegate { if (CenterPopup(owner) || ++ticks > 200) timer.Stop(); };
    timer.Start();
    int hr = d.Show(owner);
    timer.Dispose();
    if (hr == unchecked((int)0x800704C7)) return null; // ERROR_CANCELLED
    Marshal.ThrowExceptionForHR(hr);
    IShellItem result;
    d.GetResult(out result);
    string path;
    result.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
    return path;
  }
}
`;

// Single quotes only: Windows PowerShell mangles double quotes inside -Command. The C# and the inputs come
// in through environment variables. The dialog is owned by an invisible topmost form, so it opens on top
// of the browser instead of behind it, and is then centered on the screen.
const WIN_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -TypeDefinition $env:T3ORCHESTRA_PICK_CS -ReferencedAssemblies System.Windows.Forms, System.Drawing',
  '[T3OrchestraFolderPicker]::DpiAware()',
  '$owner = New-Object System.Windows.Forms.Form',
  "$owner.FormBorderStyle = 'None'",
  '$owner.ShowInTaskbar = $false',
  '$owner.TopMost = $true',
  '$owner.Opacity = 0',
  "$owner.StartPosition = 'CenterScreen'",
  '$owner.Size = New-Object System.Drawing.Size 1, 1',
  '$owner.Show()',
  '[T3OrchestraFolderPicker]::Raise($owner.Handle)',
  '$picked = [T3OrchestraFolderPicker]::Pick($owner.Handle, $env:T3ORCHESTRA_PICK_TITLE, $env:T3ORCHESTRA_PICK_START)',
  '$owner.Close()',
  'if ($picked) { [Console]::Out.Write($picked) }',
].join('; ');

const MAC_SCRIPT = [
  'on run argv',
  'activate',
  'if (item 2 of argv) is "" then',
  'set f to choose folder with prompt (item 1 of argv)',
  'else',
  'set f to choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv))',
  'end if',
  'return POSIX path of f',
  'end run',
];

interface PickerCommand {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** Exit codes and stderr that mean "closed without choosing". */
  cancelled: (code: number | null, stderr: string) => boolean;
}

function pickerCommand(title: string, startIn: string, platform = process.platform): PickerCommand | null {
  if (platform === 'win32') {
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', WIN_SCRIPT],
      env: { ...process.env, T3ORCHESTRA_PICK_CS: WIN_PICKER_CS, T3ORCHESTRA_PICK_TITLE: title, T3ORCHESTRA_PICK_START: startIn },
      cancelled: () => false, // a closed window exits 0 with no output
    };
  }
  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: [...MAC_SCRIPT.flatMap((line) => ['-e', line]), title, startIn],
      cancelled: (code, stderr) => code === 1 && /-128\b/.test(stderr),
    };
  }
  if (onPath('zenity')) {
    return {
      cmd: 'zenity',
      args: ['--file-selection', '--directory', `--title=${title}`, ...(startIn ? [`--filename=${startIn.replace(/\/?$/, '/')}`] : [])],
      cancelled: (code) => code === 1,
    };
  }
  if (onPath('kdialog')) {
    return { cmd: 'kdialog', args: ['--getexistingdirectory', startIn || '.', '--title', title], cancelled: (code) => code === 1 };
  }
  return null;
}

let busy = false;

/**
 * Lets the user choose a folder in the OS's folder window and resolves with its path, or null when they
 * close the window. One window at a time.
 */
export function pickFolder(o: { title?: string; startIn?: string } = {}): Promise<string | null> {
  const startIn = o.startIn && fs.existsSync(o.startIn) ? o.startIn : '';
  const command = pickerCommand(o.title || 'Choose a folder', startIn);
  if (!command) {
    return Promise.reject(new FolderPickerUnavailable('No folder window is available on this computer (install zenity or kdialog). Type the path instead.'));
  }
  if (busy) return Promise.reject(new FolderPickerBusy('A folder window is already open on the computer running T3 Orchestra.'));
  busy = true;
  return new Promise<string | null>((resolve, reject) => {
    const p = spawn(command.cmd, command.args, { env: command.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d: string) => (out += d));
    p.stderr.on('data', (d: string) => (err += d));
    const timer = setTimeout(() => p.kill(), PICK_TIMEOUT_MS);
    p.once('error', (e) => {
      clearTimeout(timer);
      busy = false;
      reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new FolderPickerUnavailable(`${command.cmd} is not installed. Type the path instead.`) : e);
    });
    p.once('close', (code) => {
      clearTimeout(timer);
      busy = false;
      const picked = out.replace(/^\uFEFF/, '').trim();
      if (code === 0) resolve(picked ? picked.replace(/(.)\/$/, '$1') : null);
      else if (command.cancelled(code, err)) resolve(null);
      else reject(new Error(err.trim().split(/\r?\n/).slice(-3).join(' ') || `The folder window failed (exit ${code}).`));
    });
  });
}
