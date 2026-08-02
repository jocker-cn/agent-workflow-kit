import koffi from 'koffi';

const SW_SHOW = 5;
const SW_RESTORE = 9;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_SHOWWINDOW = 0x0040;

let api = null;

function user32() {
  if (process.platform !== 'win32') throw new Error('Window activation is available only on Windows');
  if (api) return api;
  const library = koffi.load('user32.dll');
  api = {
    IsIconic: library.func('bool __stdcall IsIconic(intptr_t hWnd)'),
    IsWindow: library.func('bool __stdcall IsWindow(intptr_t hWnd)'),
    IsWindowVisible: library.func('bool __stdcall IsWindowVisible(intptr_t hWnd)'),
    ShowWindowAsync: library.func('bool __stdcall ShowWindowAsync(intptr_t hWnd, int nCmdShow)'),
    BringWindowToTop: library.func('bool __stdcall BringWindowToTop(intptr_t hWnd)'),
    SetForegroundWindow: library.func('bool __stdcall SetForegroundWindow(intptr_t hWnd)'),
    GetForegroundWindow: library.func('intptr_t __stdcall GetForegroundWindow()'),
    SetWindowPos: library.func('bool __stdcall SetWindowPos(intptr_t hWnd, intptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)'),
  };
  return api;
}

function hwndNumber(value) {
  if (typeof value === 'bigint') return Number(value);
  if (value === null || value === undefined) return 0;
  return Number(value);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function activateWindow(hwnd, { restore = false, timeoutMs = 3000 } = {}) {
  const handle = Number(hwnd);
  if (!Number.isInteger(handle) || handle <= 0) throw new Error('A positive HWND is required');
  const win = user32();
  if (!win.IsWindow(handle)) throw new Error(`HWND is no longer valid: ${handle}`);
  const iconicBefore = win.IsIconic(handle);
  if (restore && iconicBefore) win.ShowWindowAsync(handle, SW_RESTORE);
  else if (!win.IsWindowVisible(handle)) win.ShowWindowAsync(handle, SW_SHOW);

  const deadline = Date.now() + timeoutMs;
  do {
    win.SetWindowPos(handle, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    win.BringWindowToTop(handle);
    win.SetForegroundWindow(handle);
    if (hwndNumber(win.GetForegroundWindow()) === handle) {
      return {
        hwnd: handle,
        restored: Boolean(restore && iconicBefore),
        iconicBefore: Boolean(iconicBefore),
        foreground: true,
      };
    }
    await delay(50);
  } while (Date.now() <= deadline);
  throw new Error(`Unable to activate HWND ${handle} without screenshot focus`);
}

