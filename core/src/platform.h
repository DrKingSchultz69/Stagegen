#pragma once
// Windows-specific helpers: child processes, DPAPI secret protection, LAN discovery.
#include <filesystem>
#include <string>
#include <vector>

namespace platform {

std::wstring widen(const std::string& utf8);
std::string narrow(const std::wstring& wide);

// Directory containing the running executable.
std::filesystem::path exeDir();

// Runs a command line, returns everything it wrote to stdout. stderr is passed through.
// exitCode receives the process exit code (-1 if it could not be started).
std::string runCapture(const std::wstring& cmdline, int& exitCode);

// Starts a long-lived child process that is killed automatically when this process exits.
bool spawnChild(const std::wstring& cmdline, const std::filesystem::path& cwd);

// Encrypts / decrypts bytes for the current Windows user (DPAPI).
std::string protect(const std::string& plain);
std::string unprotect(const std::string& cipher);

std::string base64Encode(const std::string& bytes);
std::string base64Decode(const std::string& text);

// IPv4 addresses of active, non-loopback network adapters.
std::vector<std::string> lanIPv4();

}  // namespace platform
