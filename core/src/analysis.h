#pragma once
#include <filesystem>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace analysis {

constexpr int kSampleRate = 22050;

// Decodes any audio file ffmpeg understands into mono float samples at kSampleRate.
// Throws std::runtime_error on failure.
std::vector<float> decodeMono(const std::filesystem::path& file, const std::string& ffmpeg);

// Full music analysis: tempo, beats, downbeats, sections, key, per-frame band energies, waveform peaks.
nlohmann::json analyze(const std::vector<float>& mono, int sampleRate);

// Compact version of an analysis (no per-frame arrays) for sending to the LLM.
nlohmann::json summarize(const nlohmann::json& analysis);

}  // namespace analysis
