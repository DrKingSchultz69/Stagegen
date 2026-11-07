#include "store.h"

#include <algorithm>
#include <chrono>
#include <fstream>
#include <random>
#include <sstream>

#include "platform.h"

namespace fs = std::filesystem;
using json = nlohmann::json;

Store::Store(fs::path dataDir) : root_(std::move(dataDir)) { fs::create_directories(root_ / "projects"); }

bool Store::validId(const std::string& id) {
  if (id.empty() || id.size() > 32) return false;
  for (char c : id)
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return false;
  return true;
}

fs::path Store::projectDir(const std::string& id) const { return root_ / "projects" / id; }

bool Store::exists(const std::string& id) const {
  return validId(id) && fs::exists(projectDir(id) / "project.json");
}

std::optional<json> Store::readFile(const fs::path& p) {
  std::ifstream f(p, std::ios::binary);
  if (!f) return std::nullopt;
  std::stringstream ss;
  ss << f.rdbuf();
  try {
    return json::parse(ss.str());
  } catch (...) {
    return std::nullopt;
  }
}

void Store::writeFile(const fs::path& p, const std::string& bytes) {
  fs::path tmp = p;
  tmp += ".tmp";
  {
    std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
    f.write(bytes.data(), (std::streamsize)bytes.size());
  }
  fs::rename(tmp, p);
}

json Store::list() const {
  std::lock_guard lock(mu_);
  json out = json::array();
  for (auto& e : fs::directory_iterator(root_ / "projects")) {
    if (!e.is_directory()) continue;
    if (auto p = readFile(e.path() / "project.json")) out.push_back(*p);
  }
  std::sort(out.begin(), out.end(),
            [](const json& a, const json& b) { return a.value("updatedAt", 0.0) > b.value("updatedAt", 0.0); });
  return out;
}

static double epochMs() {
  using namespace std::chrono;
  return (double)duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

json Store::create(const std::string& name) {
  static std::mt19937_64 rng{std::random_device{}()};
  static const char* alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  std::string id;
  do {
    id.clear();
    for (int i = 0; i < 8; i++) id += alphabet[rng() % 36];
  } while (exists(id));
  json p = {{"id", id}, {"name", name.empty() ? "Untitled show" : name}, {"createdAt", epochMs()},
            {"updatedAt", epochMs()}, {"audio", nullptr}};
  std::lock_guard lock(mu_);
  fs::create_directories(projectDir(id));
  writeFile(projectDir(id) / "project.json", p.dump(2));
  return p;
}

bool Store::remove(const std::string& id) {
  if (!exists(id)) return false;
  std::lock_guard lock(mu_);
  std::error_code ec;
  fs::remove_all(projectDir(id), ec);
  return !ec;
}

std::optional<json> Store::read(const std::string& id, const std::string& file) const {
  if (!validId(id)) return std::nullopt;
  std::lock_guard lock(mu_);
  return readFile(projectDir(id) / file);
}

void Store::write(const std::string& id, const std::string& file, const json& value) {
  std::lock_guard lock(mu_);
  writeFile(projectDir(id) / file, value.dump(file == "analysis.json" ? -1 : 2));
  if (file != "project.json") {
    if (auto p = readFile(projectDir(id) / "project.json")) {
      (*p)["updatedAt"] = epochMs();
      writeFile(projectDir(id) / "project.json", p->dump(2));
    }
  }
}

void Store::erase(const std::string& id, const std::string& file) {
  std::lock_guard lock(mu_);
  std::error_code ec;
  fs::remove(projectDir(id) / file, ec);
}

json Store::settings() const {
  std::lock_guard lock(mu_);
  json s = readFile(root_ / "settings.json").value_or(json::object());
  if (!s.contains("provider")) s["provider"] = "openrouter";
  if (!s.contains("models")) s["models"] = json::object();
  if (!s["models"].contains("anthropic")) s["models"]["anthropic"] = "claude-opus-5-5";
  if (!s["models"].contains("openrouter")) s["models"]["openrouter"] = "";
  return s;
}

void Store::saveSettings(const json& s) {
  std::lock_guard lock(mu_);
  writeFile(root_ / "settings.json", s.dump(2));
}

json Store::secrets() const {
  std::lock_guard lock(mu_);
  std::ifstream f(root_ / "secrets.dat", std::ios::binary);
  if (!f) return json::object();
  std::stringstream ss;
  ss << f.rdbuf();
  try {
    return json::parse(platform::unprotect(platform::base64Decode(ss.str())));
  } catch (...) {
    return json::object();
  }
}

void Store::saveSecrets(const json& s) {
  std::lock_guard lock(mu_);
  writeFile(root_ / "secrets.dat", platform::base64Encode(platform::protect(s.dump())));
}
