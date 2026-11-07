// stagegen-core: HTTP + WebSocket server for the Stagegen studio and show outputs.
//
//  /                     studio (operator UI)
//  /show/<projectId>     fullscreen output for the show laptop
//  /api/...              projects, audio upload + analysis, LLM refinement, settings
//  /media/<id>/audio     audio file for playback
//  /ws                   show control, clock sync, live-input relay
#include "crow.h"

#include <atomic>
#include <chrono>
#include <fstream>
#include <iostream>
#include <mutex>
#include <set>
#include <sstream>
#include <unordered_map>

#include <nlohmann/json.hpp>

#include "analysis.h"
#include "gateway_client.h"
#include "platform.h"
#include "store.h"

namespace fs = std::filesystem;
using json = nlohmann::json;
using WsConn = crow::websocket::connection;

namespace {

constexpr const char* kVersion = "0.1.0";
constexpr double kLeadMs = 250.0;  // scheduled start delay so every client can start in sync

double nowMs() {
  using namespace std::chrono;
  return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

crow::response jsonResponse(int code, const json& body) {
  crow::response r(code, body.dump());
  r.set_header("Content-Type", "application/json; charset=utf-8");
  r.set_header("Cache-Control", "no-store");
  return r;
}

crow::response errorResponse(int code, const std::string& message) {
  return jsonResponse(code, {{"error", message}});
}

std::string mimeFor(const fs::path& p) {
  static const std::unordered_map<std::string, std::string> m = {
      {".html", "text/html; charset=utf-8"}, {".js", "text/javascript; charset=utf-8"},
      {".css", "text/css; charset=utf-8"},   {".json", "application/json"},
      {".svg", "image/svg+xml"},             {".png", "image/png"},
      {".jpg", "image/jpeg"},                {".webp", "image/webp"},
      {".ico", "image/x-icon"},              {".woff2", "font/woff2"},
      {".mp3", "audio/mpeg"},                {".wav", "audio/wav"},
      {".flac", "audio/flac"},               {".ogg", "audio/ogg"},
      {".opus", "audio/ogg"},                {".m4a", "audio/mp4"},
      {".aac", "audio/aac"},                 {".webm", "audio/webm"},
      {".mp4", "video/mp4"},                 {".glsl", "text/plain"}};
  std::string ext = p.extension().string();
  std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);
  auto it = m.find(ext);
  return it == m.end() ? "application/octet-stream" : it->second;
}

crow::response serveFile(const fs::path& p, const std::string& cache = "no-cache") {
  std::ifstream f(p, std::ios::binary);
  if (!f) return crow::response(404);
  std::stringstream ss;
  ss << f.rdbuf();
  crow::response r(200, ss.str());
  r.set_header("Content-Type", mimeFor(p));
  r.set_header("Cache-Control", cache);
  return r;
}

// Rejects anything that could escape the base directory.
bool safeRelative(const std::string& rel) {
  if (rel.empty() || rel.find("..") != std::string::npos || rel.find(':') != std::string::npos) return false;
  return rel[0] != '/' && rel[0] != '\\';
}

json defaultShowState() {
  return {{"mode", "track"},          // "track" (timeline playback) | "live" (manual cues + live input)
          {"playing", false},
          {"anchorPos", 0.0},         // seconds into the track at anchorServerMs
          {"anchorServerMs", 0.0},
          {"liveSection", 0},
          {"livePrevSection", 0},
          {"liveSectionSince", 0.0},
          {"bpm", 0.0},               // live mode tempo (tap / manual); 0 = use track bpm
          {"beatAnchorMs", 0.0},
          {"intensity", 1.0},
          {"blackout", false},
          {"showAudio", false},       // play the track on the show laptop as well
          {"visualOffsetMs", 0.0},    // positive = visuals later (compensate projector/PA latency)
          {"rev", 0}};
}

double currentPos(const json& s, double t) {
  double pos = s["anchorPos"].get<double>();
  if (s["playing"].get<bool>()) pos += (t - s["anchorServerMs"].get<double>()) / 1000.0;
  return pos;
}

struct Peer {
  std::string role;     // "studio" | "show"
  std::string project;
};

class Hub {
 public:
  void add(WsConn* c) {
    std::lock_guard lock(mu_);
    peers_[c] = {};
  }

  void removePeer(WsConn* c) {
    std::string project;
    {
      std::lock_guard lock(mu_);
      auto it = peers_.find(c);
      if (it == peers_.end()) return;
      project = it->second.project;
      peers_.erase(it);
    }
    if (!project.empty()) broadcastPresence(project);
  }

  void hello(WsConn* c, const std::string& role, const std::string& project) {
    json msg;
    {
      std::lock_guard lock(mu_);
      peers_[c] = {role, project};
      msg = {{"t", "state"}, {"project", project}, {"state", stateLocked(project)}, {"now", nowMs()}};
    }
    c->send_text(msg.dump());
    broadcastPresence(project);
  }

  json state(const std::string& project) {
    std::lock_guard lock(mu_);
    return stateLocked(project);
  }

  // Applies a control cue and broadcasts the new state to every client of the project.
  void cue(const std::string& project, const json& m) {
    json msg;
    {
      std::lock_guard lock(mu_);
      json& s = stateLocked(project);
      const double t = nowMs();
      const std::string cmd = m.value("cmd", "");
      if (cmd == "play") {
        double pos = m.contains("position") ? m["position"].get<double>() : currentPos(s, t);
        s["anchorPos"] = std::max(0.0, pos);
        s["anchorServerMs"] = t + kLeadMs;
        s["playing"] = true;
      } else if (cmd == "pause") {
        s["anchorPos"] = std::max(0.0, currentPos(s, t));
        s["anchorServerMs"] = t;
        s["playing"] = false;
      } else if (cmd == "seek") {
        s["anchorPos"] = std::max(0.0, m.value("position", 0.0));
        s["anchorServerMs"] = s["playing"].get<bool>() ? t + kLeadMs : t;
      } else if (cmd == "stop") {
        s["anchorPos"] = 0.0;
        s["anchorServerMs"] = t;
        s["playing"] = false;
      } else if (cmd == "mode") {
        std::string mode = m.value("mode", "track");
        if (mode == "track" || mode == "live") s["mode"] = mode;
      } else if (cmd == "section") {
        int idx = std::max(0, m.value("index", 0));
        s["livePrevSection"] = s["liveSection"];
        s["liveSection"] = idx;
        s["liveSectionSince"] = t;
      } else if (cmd == "tempo") {
        s["bpm"] = std::clamp(m.value("bpm", 0.0), 0.0, 300.0);
        // beatAt is the client's estimate of a beat time in server ms; default: now.
        s["beatAnchorMs"] = m.value("beatAt", t);
      } else if (cmd == "set") {
        if (m.contains("intensity")) s["intensity"] = std::clamp(m["intensity"].get<double>(), 0.0, 1.5);
        if (m.contains("blackout")) s["blackout"] = m["blackout"].get<bool>();
        if (m.contains("showAudio")) s["showAudio"] = m["showAudio"].get<bool>();
        if (m.contains("visualOffsetMs"))
          s["visualOffsetMs"] = std::clamp(m["visualOffsetMs"].get<double>(), -1000.0, 1000.0);
      } else {
        return;
      }
      s["rev"] = s["rev"].get<int>() + 1;
      msg = {{"t", "state"}, {"project", project}, {"state", s}, {"now", t}};
    }
    sendToProject(project, msg.dump());
  }

  void resetPlayback(const std::string& project) {
    json msg;
    {
      std::lock_guard lock(mu_);
      json& s = stateLocked(project);
      s["playing"] = false;
      s["anchorPos"] = 0.0;
      s["anchorServerMs"] = nowMs();
      s["liveSection"] = 0;
      s["livePrevSection"] = 0;
      s["rev"] = s["rev"].get<int>() + 1;
      msg = {{"t", "state"}, {"project", project}, {"state", s}, {"now", nowMs()}};
    }
    sendToProject(project, msg.dump());
  }

  void sendToProject(const std::string& project, const std::string& text, WsConn* except = nullptr,
                     const std::string& onlyRole = "") {
    std::lock_guard lock(mu_);
    for (auto& [c, p] : peers_) {
      if (c == except || p.project != project) continue;
      if (!onlyRole.empty() && p.role != onlyRole) continue;
      c->send_text(text);
    }
  }

  json presence(const std::string& project) {
    std::lock_guard lock(mu_);
    return presenceLocked(project);
  }

 private:
  json& stateLocked(const std::string& project) {
    auto it = states_.find(project);
    if (it == states_.end()) it = states_.emplace(project, defaultShowState()).first;
    return it->second;
  }

  json presenceLocked(const std::string& project) {
    int shows = 0, studios = 0;
    for (auto& [c, p] : peers_) {
      if (p.project != project) continue;
      if (p.role == "show") shows++;
      else if (p.role == "studio") studios++;
    }
    return {{"t", "presence"}, {"project", project}, {"shows", shows}, {"studios", studios}};
  }

  void broadcastPresence(const std::string& project) {
    json msg = presence(project);
    sendToProject(project, msg.dump());
  }

  std::mutex mu_;
  std::unordered_map<WsConn*, Peer> peers_;
  std::unordered_map<std::string, json> states_;
};

struct Options {
  int port = 8080;
  int gatewayPort = 8091;
  bool spawnGateway = true;
  fs::path root;
  std::string ffmpeg = "ffmpeg";
};

fs::path findRoot() {
  fs::path p = platform::exeDir();
  for (int i = 0; i < 6 && !p.empty(); i++) {
    if (fs::exists(p / "web") && fs::exists(p / "gateway")) return p;
    p = p.parent_path();
  }
  return fs::current_path();
}

Options parseArgs(int argc, char** argv) {
  Options o;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    auto next = [&]() -> std::string { return i + 1 < argc ? argv[++i] : ""; };
    if (a == "--port") o.port = std::stoi(next());
    else if (a == "--gateway-port") o.gatewayPort = std::stoi(next());
    else if (a == "--no-gateway") o.spawnGateway = false;
    else if (a == "--root") o.root = next();
    else if (a == "--ffmpeg") o.ffmpeg = next();
  }
  if (o.root.empty()) o.root = findRoot();
  if (const char* env = std::getenv("STAGEGEN_FFMPEG")) o.ffmpeg = env;
  return o;
}

std::string keyHint(const std::string& key) {
  if (key.size() < 8) return "set";
  return "..." + key.substr(key.size() - 4);
}

}  // namespace

int main(int argc, char** argv) {
  Options opt = parseArgs(argc, argv);
  const fs::path webDist = opt.root / "web" / "dist";
  Store store(opt.root / "data");
  Hub hub;
  gateway::configure("127.0.0.1", opt.gatewayPort);

  std::cout << "Stagegen core " << kVersion << "\n  root: " << opt.root.string() << "\n";
  if (!fs::exists(webDist / "index.html"))
    std::cout << "  WARNING: web/dist not found. Run `npm run build` in web/ (or use the Vite dev server).\n";

  if (opt.spawnGateway) {
    fs::path script = opt.root / "gateway" / "server.mjs";
    std::wstring cmd = L"node \"" + script.wstring() + L"\" --port " + std::to_wstring(opt.gatewayPort);
    if (platform::spawnChild(cmd, opt.root / "gateway"))
      std::cout << "  ai-gateway: started on 127.0.0.1:" << opt.gatewayPort << "\n";
    else
      std::cout << "  ai-gateway: could not start `node` (is Node.js installed?) - LLM features disabled\n";
  }

  // Resolves an API key: stored secret first, then environment variable.
  auto apiKey = [&](const std::string& provider) -> std::pair<std::string, std::string> {
    json sec = store.secrets();
    if (sec.contains(provider) && sec[provider].is_string() && !sec[provider].get<std::string>().empty())
      return {sec[provider].get<std::string>(), "settings"};
    const char* envName = provider == "openrouter" ? "OPENROUTER_API_KEY"
                          : provider == "anthropic" ? "ANTHROPIC_API_KEY"
                          : provider == "kie"       ? "KIE_API_KEY"
                                                    : nullptr;
    if (envName)
      if (const char* v = std::getenv(envName); v && *v) return {v, "env"};
    return {"", ""};
  };

  auto fullProject = [&](const std::string& id) -> json {
    json out = {{"project", store.read(id, "project.json").value_or(json())},
                {"analysis", store.read(id, "analysis.json").value_or(json())},
                {"plan", store.read(id, "plan.json").value_or(json())},
                {"state", hub.state(id)},
                {"serverNow", nowMs()}};
    return out;
  };

  crow::SimpleApp app;
  app.loglevel(crow::LogLevel::Warning);

  // ---------------------------------------------------------------- pages
  auto studioPage = [&]() { return serveFile(webDist / "index.html"); };
  CROW_ROUTE(app, "/")([&] { return studioPage(); });
  CROW_ROUTE(app, "/show/<string>")([&](const std::string&) { return serveFile(webDist / "show.html"); });
  CROW_ROUTE(app, "/assets/<path>")([&](const std::string& rel) {
    if (!safeRelative(rel)) return crow::response(404);
    return serveFile(webDist / "assets" / rel, "public, max-age=31536000, immutable");
  });
  CROW_ROUTE(app, "/favicon.svg")([&] { return serveFile(webDist / "favicon.svg"); });

  // ---------------------------------------------------------------- info
  CROW_ROUTE(app, "/api/info")([&] {
    auto health = gateway::get("/health", 2);
    return jsonResponse(200, {{"name", "stagegen"},
                              {"version", kVersion},
                              {"port", opt.port},
                              {"lan", platform::lanIPv4()},
                              {"gateway", {{"ok", health.status == 200}}},
                              {"serverNow", nowMs()}});
  });

  // ---------------------------------------------------------------- projects
  CROW_ROUTE(app, "/api/projects").methods(crow::HTTPMethod::Get, crow::HTTPMethod::Post)(
      [&](const crow::request& req) {
        if (req.method == crow::HTTPMethod::Get) return jsonResponse(200, store.list());
        json body = json::parse(req.body.empty() ? "{}" : req.body, nullptr, false);
        std::string name = body.is_object() ? body.value("name", "") : "";
        return jsonResponse(201, store.create(name.substr(0, 120)));
      });

  CROW_ROUTE(app, "/api/projects/<string>")
      .methods(crow::HTTPMethod::Get, crow::HTTPMethod::Delete, crow::HTTPMethod::Patch)(
          [&](const crow::request& req, const std::string& id) {
            if (!store.exists(id)) return errorResponse(404, "Project not found");
            if (req.method == crow::HTTPMethod::Delete) {
              store.remove(id);
              return jsonResponse(200, {{"ok", true}});
            }
            if (req.method == crow::HTTPMethod::Patch) {
              json body = json::parse(req.body, nullptr, false);
              json p = store.read(id, "project.json").value_or(json::object());
              if (body.is_object() && body.contains("name") && body["name"].is_string())
                p["name"] = body["name"].get<std::string>().substr(0, 120);
              store.write(id, "project.json", p);
              return jsonResponse(200, p);
            }
            return jsonResponse(200, fullProject(id));
          });

  // Raw audio upload. Body = file bytes, header X-Filename = original name.
  CROW_ROUTE(app, "/api/projects/<string>/audio").methods(crow::HTTPMethod::Put)(
      [&](const crow::request& req, const std::string& id) {
        if (!store.exists(id)) return errorResponse(404, "Project not found");
        if (req.body.size() < 1024) return errorResponse(400, "Empty or too small audio upload");
        std::string original = req.get_header_value("X-Filename");
        std::string ext = fs::path(platform::widen(original)).extension().string();
        std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);
        static const std::set<std::string> allowed = {".mp3", ".wav", ".flac", ".ogg", ".opus", ".m4a",
                                                      ".aac", ".webm", ".aif", ".aiff", ".wma"};
        if (!allowed.count(ext)) return errorResponse(400, "Unsupported audio type: " + ext);

        fs::path dir = store.projectDir(id);
        for (auto& e : fs::directory_iterator(dir)) {
          auto stem = e.path().stem().string();
          if (stem == "audio" || stem == "playback") fs::remove(e.path());
        }
        fs::path src = dir / ("audio" + ext);
        {
          std::ofstream f(src, std::ios::binary);
          f.write(req.body.data(), (std::streamsize)req.body.size());
        }
        // Browsers can't decode every format; transcode the rest to WAV for playback.
        static const std::set<std::string> browserFriendly = {".mp3", ".wav", ".flac", ".ogg",
                                                              ".opus", ".m4a", ".aac", ".webm"};
        std::string playback = src.filename().string();
        if (!browserFriendly.count(ext)) {
          fs::path out = dir / "playback.wav";
          std::wstring cmd = L"\"" + platform::widen(opt.ffmpeg) + L"\" -nostdin -v error -y -i \"" +
                             src.wstring() + L"\" -c:a pcm_s16le \"" + out.wstring() + L"\"";
          int code = 0;
          platform::runCapture(cmd, code);
          if (code != 0) return errorResponse(500, "Could not transcode audio for browser playback");
          playback = out.filename().string();
        }

        json analysisJson;
        try {
          auto t0 = nowMs();
          auto mono = analysis::decodeMono(src, opt.ffmpeg);
          analysisJson = analysis::analyze(mono, analysis::kSampleRate);
          std::cout << "  analyzed " << original << " in " << (int)(nowMs() - t0) << " ms: "
                    << analysisJson["bpm"] << " BPM, " << analysisJson["sections"].size() << " sections\n";
        } catch (const std::exception& e) {
          return errorResponse(422, e.what());
        }
        store.write(id, "analysis.json", analysisJson);
        store.erase(id, "plan.json");
        json p = store.read(id, "project.json").value_or(json::object());
        p["audio"] = {{"originalName", original},
                      {"file", src.filename().string()},
                      {"playback", playback},
                      {"size", req.body.size()},
                      {"duration", analysisJson["duration"]}};
        store.write(id, "project.json", p);
        hub.resetPlayback(id);
        hub.sendToProject(id, json({{"t", "reload"}, {"project", id}, {"what", "analysis"}}).dump());
        return jsonResponse(200, fullProject(id));
      });

  CROW_ROUTE(app, "/media/<string>/audio")([&](const std::string& id) {
    if (!store.exists(id)) return crow::response(404);
    json p = store.read(id, "project.json").value_or(json::object());
    if (!p.contains("audio") || p["audio"].is_null()) return crow::response(404);
    std::string file = p["audio"].value("playback", p["audio"].value("file", ""));
    if (!safeRelative(file)) return crow::response(404);
    return serveFile(store.projectDir(id) / file);
  });

  // ---------------------------------------------------------------- plan / refinement
  CROW_ROUTE(app, "/api/projects/<string>/plan").methods(crow::HTTPMethod::Put)(
      [&](const crow::request& req, const std::string& id) {
        if (!store.exists(id)) return errorResponse(404, "Project not found");
        json plan = json::parse(req.body, nullptr, false);
        if (!plan.is_object() || !plan.contains("sections")) return errorResponse(400, "Invalid plan");
        store.write(id, "plan.json", plan);
        hub.sendToProject(id, json({{"t", "reload"}, {"project", id}, {"what", "plan"}}).dump());
        return jsonResponse(200, plan);
      });

  CROW_ROUTE(app, "/api/projects/<string>/refine").methods(crow::HTTPMethod::Post)(
      [&](const crow::request& req, const std::string& id) {
        if (!store.exists(id)) return errorResponse(404, "Project not found");
        auto analysisJson = store.read(id, "analysis.json");
        if (!analysisJson) return errorResponse(400, "Upload an audio file first");
        json body = json::parse(req.body, nullptr, false);
        if (!body.is_object()) return errorResponse(400, "Invalid JSON");
        std::string prompt = body.value("prompt", "");
        if (prompt.empty()) return errorResponse(400, "Write a prompt first");

        json settings = store.settings();
        std::string provider = body.value("provider", settings.value("provider", "openrouter"));
        std::string model = body.value("model", "");
        if (model.empty()) model = settings["models"].value(provider, "");
        auto [key, source] = apiKey(provider);
        if (key.empty())
          return errorResponse(400, "No API key for " + provider + ". Add one in Settings.");

        json project = store.read(id, "project.json").value_or(json::object());
        json payload = {{"provider", provider},
                        {"model", model},
                        {"apiKey", key},
                        {"prompt", prompt.substr(0, 4000)},
                        {"projectName", project.value("name", "")},
                        {"analysis", analysis::summarize(*analysisJson)}};
        if (body.value("revise", false))
          if (auto prev = store.read(id, "plan.json")) payload["previousPlan"] = *prev;

        auto res = gateway::post("/refine", payload.dump(), 300);
        if (res.status == 0) return errorResponse(502, res.body);
        json out = json::parse(res.body, nullptr, false);
        if (res.status != 200 || !out.is_object() || !out.contains("plan"))
          return errorResponse(res.status ? res.status : 502,
                               out.is_object() ? out.value("error", "Refinement failed") : "Refinement failed");
        json plan = out["plan"];
        plan["prompt"] = prompt;
        plan["provider"] = provider;
        plan["model"] = out.value("model", model);
        plan["createdAt"] = nowMs();
        store.write(id, "plan.json", plan);
        hub.sendToProject(id, json({{"t", "reload"}, {"project", id}, {"what", "plan"}}).dump());
        return jsonResponse(200, plan);
      });

  // ---------------------------------------------------------------- settings
  CROW_ROUTE(app, "/api/settings").methods(crow::HTTPMethod::Get, crow::HTTPMethod::Put)(
      [&](const crow::request& req) {
        if (req.method == crow::HTTPMethod::Put) {
          json body = json::parse(req.body, nullptr, false);
          if (!body.is_object()) return errorResponse(400, "Invalid JSON");
          json s = store.settings();
          if (body.contains("provider") && body["provider"].is_string()) {
            std::string p = body["provider"];
            if (p == "openrouter" || p == "anthropic") s["provider"] = p;
          }
          if (body.contains("models") && body["models"].is_object())
            for (auto& [k, v] : body["models"].items())
              if ((k == "openrouter" || k == "anthropic") && v.is_string()) s["models"][k] = v;
          store.saveSettings(s);
          if (body.contains("keys") && body["keys"].is_object()) {
            json sec = store.secrets();
            for (auto& [k, v] : body["keys"].items()) {
              if (k != "openrouter" && k != "anthropic" && k != "kie") continue;
              if (!v.is_string()) continue;
              if (v.get<std::string>().empty()) sec.erase(k);
              else sec[k] = v;
            }
            store.saveSecrets(sec);
          }
        }
        json s = store.settings();
        json keys = json::object();
        for (const char* k : {"openrouter", "anthropic", "kie"}) {
          auto [key, source] = apiKey(k);
          keys[k] = {{"set", !key.empty()}, {"hint", key.empty() ? "" : keyHint(key)}, {"source", source}};
        }
        s["keys"] = keys;
        return jsonResponse(200, s);
      });

  CROW_ROUTE(app, "/api/models")([&](const crow::request& req) {
    std::string provider = req.url_params.get("provider") ? req.url_params.get("provider") : "openrouter";
    if (provider != "openrouter" && provider != "anthropic") return errorResponse(400, "Unknown provider");
    auto res = gateway::get("/models?provider=" + provider, 20);
    if (res.status == 0) return errorResponse(502, res.body);
    crow::response r(res.status, res.body);
    r.set_header("Content-Type", "application/json");
    return r;
  });

  // ---------------------------------------------------------------- websocket
  CROW_WEBSOCKET_ROUTE(app, "/ws")
      .onopen([&](WsConn& c) { hub.add(&c); })
      .onclose([&](WsConn& c, const std::string&, auto&&...) { hub.removePeer(&c); })
      .onmessage([&](WsConn& c, const std::string& data, bool isBinary) {
        if (isBinary) return;
        json m = json::parse(data, nullptr, false);
        if (!m.is_object()) return;
        const std::string t = m.value("t", "");
        if (t == "ping") {
          c.send_text(json({{"t", "pong"}, {"c", m.value("c", 0.0)}, {"s", nowMs()}}).dump());
          return;
        }
        const std::string project = m.value("project", "");
        if (!Store::validId(project)) return;
        if (t == "hello") {
          std::string role = m.value("role", "show");
          hub.hello(&c, role == "studio" ? "studio" : "show", project);
        } else if (t == "cue") {
          hub.cue(project, m);
        } else if (t == "live") {
          // Live-input band levels from the studio, relayed to the show outputs.
          hub.sendToProject(project, data, &c, "show");
        }
      });

  std::cout << "\n  Studio:  http://localhost:" << opt.port << "/\n";
  for (auto& ip : platform::lanIPv4())
    std::cout << "  On LAN:  http://" << ip << ":" << opt.port << "/show/<projectId>\n";
  std::cout << std::endl;

  app.port((uint16_t)opt.port).bindaddr("0.0.0.0").multithreaded().run();
  return 0;
}
