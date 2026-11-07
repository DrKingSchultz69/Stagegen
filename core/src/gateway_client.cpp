#include "gateway_client.h"

#include <httplib.h>

namespace gateway {
namespace {
std::string g_host = "127.0.0.1";
int g_port = 8091;
}

void configure(const std::string& host, int port) {
  g_host = host;
  g_port = port;
}

Result get(const std::string& path, int timeoutSec) {
  httplib::Client cli(g_host, g_port);
  cli.set_connection_timeout(3, 0);
  cli.set_read_timeout(timeoutSec, 0);
  auto res = cli.Get(path);
  if (!res) return {0, "ai-gateway is not reachable: " + httplib::to_string(res.error())};
  return {res->status, res->body};
}

Result post(const std::string& path, const std::string& body, int timeoutSec) {
  httplib::Client cli(g_host, g_port);
  cli.set_connection_timeout(3, 0);
  cli.set_read_timeout(timeoutSec, 0);
  cli.set_write_timeout(30, 0);
  auto res = cli.Post(path, body, "application/json");
  if (!res) return {0, "ai-gateway is not reachable: " + httplib::to_string(res.error())};
  return {res->status, res->body};
}

}  // namespace gateway
