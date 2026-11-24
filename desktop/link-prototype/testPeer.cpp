// SPDX-License-Identifier: AGPL-3.0-only

#include <ableton/Link.hpp>

#include <cwchar>
#include <exception>
#include <iomanip>
#include <iostream>
#include <locale>
#include <string>

#ifdef _WIN32
#include <windows.h>
#endif

namespace
{
class TestPeer
{
public:
  TestPeer()
  {
    link.enableStartStopSync(false);
    link.enable(true);
  }

  ~TestPeer() { link.enable(false); }

  void setTempo(double bpm)
  {
    if (!enabled()) return;
    auto state = link.captureAppSessionState();
    state.setTempo(bpm, link.clock().micros());
    link.commitAppSessionState(state);
  }

  void setEnabled(bool enabled) { link.enable(enabled); }
  bool enabled() const { return link.isEnabled(); }
  std::size_t peers() const { return enabled() ? link.numPeers() : 0; }
  double bpm() const { return link.captureAppSessionState().tempo(); }

private:
  ableton::Link link{120.0};
};

// Deterministic automation of the same controls the Windows GUI exposes.
int runPipeTest()
{
  TestPeer peer;
  std::cout.imbue(std::locale::classic());
  std::cout << std::setprecision(12);
  std::string command;
  while (std::getline(std::cin, command))
  {
    if (!command.empty() && command.back() == '\r') command.pop_back();
    if (command == "quit") break;
    if (command == "connect") peer.setEnabled(true);
    else if (command == "disconnect") peer.setEnabled(false);
    else if (command == "90") peer.setTempo(90);
    else if (command == "120") peer.setTempo(120);
    else if (command == "140") peer.setTempo(140);
    else if (command != "sample") return 2;

    std::cout << "{\"bpm\":" << peer.bpm() << ",\"peers\":" << peer.peers()
              << ",\"enabled\":" << (peer.enabled() ? "true" : "false") << "}\n" << std::flush;
    if (!std::cout) break;
  }
  return 0;
}

#ifdef _WIN32
constexpr int kStatus = 101;
constexpr int kToggle = 102;
constexpr int kBpm90 = 103;
constexpr int kBpm120 = 104;
constexpr int kBpm140 = 105;

HWND control(HWND window, const wchar_t* kind, const wchar_t* text, int x, int y,
             int width, int height, int id, DWORD style = 0)
{
  const auto child = CreateWindowExW(0, kind, text, WS_CHILD | WS_VISIBLE | style,
    x, y, width, height, window, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)),
    GetModuleHandleW(nullptr), nullptr);
  SendMessageW(child, WM_SETFONT, reinterpret_cast<WPARAM>(GetStockObject(DEFAULT_GUI_FONT)), TRUE);
  return child;
}

void showStatus(HWND window, const TestPeer& peer)
{
  wchar_t text[128]{};
  swprintf(text, 128, L"%ls   |   %.1f BPM   |   %zu peer(s)",
    peer.enabled() ? L"Link enabled" : L"Disconnected", peer.bpm(), peer.peers());
  SetDlgItemTextW(window, kStatus, text);
  SetDlgItemTextW(window, kToggle, peer.enabled() ? L"Disconnect" : L"Reconnect");
  for (const auto id : {kBpm90, kBpm120, kBpm140}) EnableWindow(GetDlgItem(window, id), peer.enabled());
}

LRESULT CALLBACK windowProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam)
{
  if (message == WM_NCCREATE)
  {
    const auto create = reinterpret_cast<const CREATESTRUCTW*>(lparam);
    SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(create->lpCreateParams));
  }
  const auto peer = reinterpret_cast<TestPeer*>(GetWindowLongPtrW(window, GWLP_USERDATA));
  switch (message)
  {
    case WM_CREATE:
      control(window, L"STATIC", L"Tempo buttons change the shared Link session.", 16, 16, 360, 24, -1);
      control(window, L"STATIC", L"", 16, 49, 360, 24, kStatus);
      control(window, L"BUTTON", L"90 BPM", 16, 83, 76, 29, kBpm90, WS_TABSTOP);
      control(window, L"BUTTON", L"120 BPM", 99, 83, 76, 29, kBpm120, WS_TABSTOP);
      control(window, L"BUTTON", L"140 BPM", 181, 83, 76, 29, kBpm140, WS_TABSTOP);
      control(window, L"BUTTON", L"", 269, 83, 108, 29, kToggle, WS_TABSTOP);
      SetTimer(window, 1, 250, nullptr);
      showStatus(window, *peer);
      return 0;
    case WM_COMMAND:
      switch (LOWORD(wparam))
      {
        case kToggle: peer->setEnabled(!peer->enabled()); break;
        case kBpm90: peer->setTempo(90); break;
        case kBpm120: peer->setTempo(120); break;
        case kBpm140: peer->setTempo(140); break;
      }
      showStatus(window, *peer);
      return 0;
    case WM_TIMER:
      showStatus(window, *peer);
      return 0;
    case WM_DESTROY:
      KillTimer(window, 1);
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(window, message, wparam, lparam);
}

int runWindow()
{
  FreeConsole();
  SetProcessDPIAware();
  TestPeer peer;
  WNDCLASSW type{};
  type.lpfnWndProc = windowProc;
  type.hInstance = GetModuleHandleW(nullptr);
  type.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512));
  type.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_BTNFACE + 1);
  type.lpszClassName = L"HydractrlLinkTestPeer";
  if (!RegisterClassW(&type)) return 1;
  constexpr DWORD style = WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
  RECT bounds{0, 0, 394, 130};
  AdjustWindowRect(&bounds, style, FALSE);
  const auto window = CreateWindowExW(0, type.lpszClassName, L"HYDRACTRL Link Test Peer", style,
    CW_USEDEFAULT, CW_USEDEFAULT, bounds.right - bounds.left, bounds.bottom - bounds.top,
    nullptr, nullptr, type.hInstance, &peer);
  if (!window) return 1;
  ShowWindow(window, SW_SHOW);
  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0)
  {
    if (IsDialogMessageW(window, &message)) continue;
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  return 0;
}
#endif
} // namespace

int main(int argc, char** argv)
{
  try
  {
    if (argc == 2 && std::string(argv[1]) == "--pipe") return runPipeTest();
#ifdef _WIN32
    if (argc == 1) return runWindow();
#endif
    return 2;
  }
  catch (const std::exception& error)
  {
    std::cerr << "Link Test Peer: " << error.what() << '\n';
    return 1;
  }
}
