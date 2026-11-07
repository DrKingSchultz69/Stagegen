#pragma once
#include <string>

// Minimal HTTP client for the local ai-gateway sidecar (Node).
namespace gateway {

struct Result {
  int status = 0;     // 0 = could not connect
  std::string body;
};

void configure(const std::string& host, int port);
Result get(const std::string& path, int timeoutSec = 15);
Result post(const std::string& path, const std::string& jsonBody, int timeoutSec = 240);

}  // namespace gateway
