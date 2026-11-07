#include "platform.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#include <windows.h>
#include <wincrypt.h>

#include <stdexcept>

namespace platform {

std::wstring widen(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n);
  return w;
}

std::string narrow(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}

std::filesystem::path exeDir() {
  std::wstring buf(MAX_PATH, L'\0');
  for (;;) {
    DWORD n = GetModuleFileNameW(nullptr, buf.data(), (DWORD)buf.size());
    if (n < buf.size()) { buf.resize(n); break; }
    buf.resize(buf.size() * 2);
  }
  return std::filesystem::path(buf).parent_path();
}

std::string runCapture(const std::wstring& cmdline, int& exitCode) {
  exitCode = -1;
  SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
  HANDLE readEnd = nullptr, writeEnd = nullptr;
  if (!CreatePipe(&readEnd, &writeEnd, &sa, 0)) return {};
  SetHandleInformation(readEnd, HANDLE_FLAG_INHERIT, 0);

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdOutput = writeEnd;
  si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  PROCESS_INFORMATION pi{};
  std::wstring cmd = cmdline;
  BOOL ok = CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr,
                           nullptr, &si, &pi);
  CloseHandle(writeEnd);
  if (!ok) {
    CloseHandle(readEnd);
    return {};
  }
  std::string out;
  char buf[1 << 16];
  DWORD got = 0;
  while (ReadFile(readEnd, buf, sizeof(buf), &got, nullptr) && got > 0) out.append(buf, got);
  CloseHandle(readEnd);
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 0;
  GetExitCodeProcess(pi.hProcess, &code);
  exitCode = (int)code;
  CloseHandle(pi.hProcess);
  CloseHandle(pi.hThread);
  return out;
}

bool spawnChild(const std::wstring& cmdline, const std::filesystem::path& cwd) {
  static HANDLE job = [] {
    HANDLE j = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info{};
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(j, JobObjectExtendedLimitInformation, &info, sizeof(info));
    return j;
  }();
  STARTUPINFOW si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  std::wstring cmd = cmdline;
  std::wstring dir = cwd.wstring();
  if (!CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED, nullptr,
                      dir.c_str(), &si, &pi))
    return false;
  AssignProcessToJobObject(job, pi.hProcess);
  ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return true;
}

std::string protect(const std::string& plain) {
  DATA_BLOB in{(DWORD)plain.size(), (BYTE*)plain.data()};
  DATA_BLOB out{};
  if (!CryptProtectData(&in, L"stagegen", nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out))
    throw std::runtime_error("CryptProtectData failed");
  std::string r((char*)out.pbData, out.cbData);
  LocalFree(out.pbData);
  return r;
}

std::string unprotect(const std::string& cipher) {
  DATA_BLOB in{(DWORD)cipher.size(), (BYTE*)cipher.data()};
  DATA_BLOB out{};
  if (!CryptUnprotectData(&in, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out))
    throw std::runtime_error("CryptUnprotectData failed");
  std::string r((char*)out.pbData, out.cbData);
  LocalFree(out.pbData);
  return r;
}

static const char* B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64Encode(const std::string& in) {
  std::string out;
  out.reserve((in.size() + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 2 < in.size(); i += 3) {
    unsigned v = ((unsigned char)in[i] << 16) | ((unsigned char)in[i + 1] << 8) | (unsigned char)in[i + 2];
    out += B64[(v >> 18) & 63]; out += B64[(v >> 12) & 63]; out += B64[(v >> 6) & 63]; out += B64[v & 63];
  }
  if (i + 1 == in.size()) {
    unsigned v = (unsigned char)in[i] << 16;
    out += B64[(v >> 18) & 63]; out += B64[(v >> 12) & 63]; out += "==";
  } else if (i + 2 == in.size()) {
    unsigned v = ((unsigned char)in[i] << 16) | ((unsigned char)in[i + 1] << 8);
    out += B64[(v >> 18) & 63]; out += B64[(v >> 12) & 63]; out += B64[(v >> 6) & 63]; out += '=';
  }
  return out;
}

std::string base64Decode(const std::string& in) {
  int map[256];
  for (int& m : map) m = -1;
  for (int i = 0; i < 64; i++) map[(unsigned char)B64[i]] = i;
  std::string out;
  unsigned v = 0;
  int bits = 0;
  for (char c : in) {
    int d = map[(unsigned char)c];
    if (d < 0) continue;
    v = (v << 6) | d;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += (char)((v >> bits) & 0xFF);
    }
  }
  return out;
}

std::vector<std::string> lanIPv4() {
  std::vector<std::string> ips;
  ULONG size = 16 * 1024;
  std::vector<unsigned char> buf(size);
  ULONG flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
  ULONG rc = GetAdaptersAddresses(AF_INET, flags, nullptr, (IP_ADAPTER_ADDRESSES*)buf.data(), &size);
  if (rc == ERROR_BUFFER_OVERFLOW) {
    buf.resize(size);
    rc = GetAdaptersAddresses(AF_INET, flags, nullptr, (IP_ADAPTER_ADDRESSES*)buf.data(), &size);
  }
  if (rc != NO_ERROR) return ips;
  for (auto* a = (IP_ADAPTER_ADDRESSES*)buf.data(); a; a = a->Next) {
    if (a->OperStatus != IfOperStatusUp || a->IfType == IF_TYPE_SOFTWARE_LOOPBACK) continue;
    for (auto* u = a->FirstUnicastAddress; u; u = u->Next) {
      char s[INET_ADDRSTRLEN] = {};
      auto* sin = (sockaddr_in*)u->Address.lpSockaddr;
      inet_ntop(AF_INET, &sin->sin_addr, s, sizeof(s));
      std::string ip = s;
      if (ip.rfind("169.254.", 0) == 0 || ip.rfind("127.", 0) == 0) continue;
      ips.push_back(ip);
    }
  }
  return ips;
}

}  // namespace platform
