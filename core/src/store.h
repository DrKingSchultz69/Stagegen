#pragma once
// File-based project store: data/projects/<id>/{project.json, analysis.json, plan.json, audio.*}
#include <filesystem>
#include <mutex>
#include <optional>
#include <string>

#include <nlohmann/json.hpp>

class Store {
 public:
  explicit Store(std::filesystem::path dataDir);

  static bool validId(const std::string& id);

  std::filesystem::path projectDir(const std::string& id) const;
  bool exists(const std::string& id) const;

  nlohmann::json list() const;
  nlohmann::json create(const std::string& name);
  bool remove(const std::string& id);

  std::optional<nlohmann::json> read(const std::string& id, const std::string& file) const;
  void write(const std::string& id, const std::string& file, const nlohmann::json& value);
  void erase(const std::string& id, const std::string& file);

  // Settings are plain JSON; secrets (API keys) are DPAPI-encrypted for the current Windows user.
  nlohmann::json settings() const;
  void saveSettings(const nlohmann::json& s);
  nlohmann::json secrets() const;
  void saveSecrets(const nlohmann::json& s);

 private:
  static std::optional<nlohmann::json> readFile(const std::filesystem::path& p);
  static void writeFile(const std::filesystem::path& p, const std::string& bytes);

  std::filesystem::path root_;
  mutable std::mutex mu_;
};
