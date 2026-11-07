#include "analysis.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstring>
#include <numeric>
#include <stdexcept>

#include "platform.h"

using json = nlohmann::json;

namespace analysis {
namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr int kFft = 2048;
constexpr int kHop = 512;

double r3(double v) { return std::round(v * 1000.0) / 1000.0; }

void fft(std::vector<std::complex<float>>& a) {
  const size_t n = a.size();
  for (size_t i = 1, j = 0; i < n; i++) {
    size_t bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) std::swap(a[i], a[j]);
  }
  for (size_t len = 2; len <= n; len <<= 1) {
    double ang = -2 * kPi / (double)len;
    std::complex<float> wl((float)std::cos(ang), (float)std::sin(ang));
    for (size_t i = 0; i < n; i += len) {
      std::complex<float> w(1.f, 0.f);
      for (size_t k = 0; k < len / 2; k++) {
        auto u = a[i + k];
        auto v = a[i + k + len / 2] * w;
        a[i + k] = u + v;
        a[i + k + len / 2] = u - v;
        w *= wl;
      }
    }
  }
}

double percentile(std::vector<double> v, double p) {
  if (v.empty()) return 0;
  size_t k = (size_t)std::clamp(p * (double)(v.size() - 1), 0.0, (double)(v.size() - 1));
  std::nth_element(v.begin(), v.begin() + k, v.end());
  return v[k];
}

double mean(const std::vector<double>& v, size_t a, size_t b) {
  if (b <= a) return 0;
  double s = 0;
  for (size_t i = a; i < b; i++) s += v[i];
  return s / (double)(b - a);
}

std::vector<double> movingAverage(const std::vector<double>& v, int radius) {
  std::vector<double> out(v.size());
  std::vector<double> pre(v.size() + 1, 0.0);
  for (size_t i = 0; i < v.size(); i++) pre[i + 1] = pre[i] + v[i];
  for (size_t i = 0; i < v.size(); i++) {
    size_t a = (size_t)std::max<long long>(0, (long long)i - radius);
    size_t b = std::min(v.size(), i + radius + 1);
    out[i] = (pre[b] - pre[a]) / (double)(b - a);
  }
  return out;
}

json toBytes(const std::vector<double>& v, double ref, double gamma) {
  json arr = json::array();
  ref = std::max(ref, 1e-12);
  for (double x : v) {
    double n = std::clamp(x / ref, 0.0, 1.0);
    arr.push_back((int)std::lround(std::pow(n, gamma) * 255.0));
  }
  return arr;
}

const char* kKeyNames[12] = {"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"};

}  // namespace

std::vector<float> decodeMono(const std::filesystem::path& file, const std::string& ffmpeg) {
  std::wstring cmd = L"\"" + platform::widen(ffmpeg) + L"\" -nostdin -hide_banner -v error -i \"" +
                     file.wstring() + L"\" -vn -ac 1 -ar " + std::to_wstring(kSampleRate) +
                     L" -f f32le -";
  int code = 0;
  std::string raw = platform::runCapture(cmd, code);
  if (code == -1) throw std::runtime_error("Could not start ffmpeg. Install it and make sure it is on PATH.");
  if (code != 0 || raw.size() < sizeof(float) * kSampleRate)
    throw std::runtime_error("ffmpeg could not decode this audio file (exit code " + std::to_string(code) + ").");
  std::vector<float> samples(raw.size() / sizeof(float));
  std::memcpy(samples.data(), raw.data(), samples.size() * sizeof(float));
  return samples;
}

json analyze(const std::vector<float>& x, int sr) {
  const double fps = (double)sr / kHop;
  const double duration = (double)x.size() / sr;
  const int nFrames = std::max(1, (int)((x.size() + kHop - 1) / kHop));
  const int nBins = kFft / 2 + 1;

  std::vector<float> window(kFft);
  for (int i = 0; i < kFft; i++) window[i] = 0.5f - 0.5f * (float)std::cos(2 * kPi * i / kFft);

  auto binOf = [&](double hz) { return std::clamp((int)std::lround(hz * kFft / sr), 0, nBins - 1); };
  const int lowA = binOf(20), lowB = binOf(150), midB = binOf(2000), highB = nBins - 1, fluxB = binOf(8000);

  // Pitch class per bin for chroma (55 Hz .. 5 kHz).
  std::vector<int> pitchClass(nBins, -1);
  for (int k = 1; k < nBins; k++) {
    double f = (double)k * sr / kFft;
    if (f < 55 || f > 5000) continue;
    int midi = (int)std::lround(12.0 * std::log2(f / 440.0) + 69.0);
    pitchClass[k] = ((midi % 12) + 12) % 12;
  }

  std::vector<double> low(nFrames), mid(nFrames), high(nFrames), rms(nFrames), flux(nFrames),
      lowFlux(nFrames), centroid(nFrames);
  std::vector<std::array<double, 12>> chroma(nFrames);
  std::vector<std::complex<float>> buf(kFft);
  std::vector<float> mag(nBins), prevLog(nBins, 0.f);
  double prevLow = 0;

  for (int t = 0; t < nFrames; t++) {
    long long start = (long long)t * kHop - kFft / 2;
    double sq = 0;
    for (int i = 0; i < kFft; i++) {
      long long idx = start + i;
      float s = (idx >= 0 && idx < (long long)x.size()) ? x[(size_t)idx] : 0.f;
      sq += (double)s * s;
      buf[i] = {s * window[i], 0.f};
    }
    rms[t] = std::sqrt(sq / kFft);
    fft(buf);
    double eLow = 0, eMid = 0, eHigh = 0, fl = 0, cNum = 0, cDen = 0;
    auto& ch = chroma[t];
    ch.fill(0);
    for (int k = 0; k < nBins; k++) {
      float m = std::abs(buf[k]);
      mag[k] = m;
      double p = (double)m * m;
      if (k >= lowA && k < lowB) eLow += p;
      else if (k >= lowB && k < midB) eMid += p;
      else if (k >= midB && k <= highB) eHigh += p;
      float lg = std::log1p(m);
      if (k <= fluxB) fl += std::max(0.f, lg - prevLog[k]);
      prevLog[k] = lg;
      if (pitchClass[k] >= 0) ch[pitchClass[k]] += m;
      double f = (double)k * sr / kFft;
      cNum += f * m;
      cDen += m;
    }
    low[t] = std::sqrt(eLow);
    mid[t] = std::sqrt(eMid);
    high[t] = std::sqrt(eHigh);
    flux[t] = t == 0 ? 0 : fl;
    lowFlux[t] = std::max(0.0, low[t] - prevLow);
    prevLow = low[t];
    centroid[t] = cDen > 0 ? cNum / cDen : 0;
  }

  // ---- Onset envelope: detrended + normalized spectral flux.
  std::vector<double> onset(nFrames);
  {
    auto avg = movingAverage(flux, (int)std::lround(0.5 * fps));
    for (int t = 0; t < nFrames; t++) onset[t] = std::max(0.0, flux[t] - avg[t]);
    double m = mean(onset, 0, onset.size()), var = 0;
    for (double v : onset) var += (v - m) * (v - m);
    double sd = std::sqrt(var / std::max(1, nFrames)) + 1e-9;
    for (double& v : onset) v /= sd;
  }

  // ---- Tempo via autocorrelation with a log-normal prior around 120 BPM.
  double bpm = 0;
  {
    int minLag = (int)std::floor(60.0 * fps / 220.0), maxLag = (int)std::ceil(60.0 * fps / 45.0);
    std::vector<double> score(maxLag + 2, 0.0);
    for (int lag = minLag; lag <= maxLag + 1 && lag < nFrames; lag++) {
      double s = 0;
      for (int t = 0; t + lag < nFrames; t++) s += onset[t] * onset[t + lag];
      double b = 60.0 * fps / lag;
      double w = std::exp(-0.5 * std::pow(std::log2(b / 120.0) / 0.9, 2));
      score[lag] = s / (nFrames - lag) * w;
    }
    int best = minLag;
    for (int lag = minLag; lag <= maxLag && lag < nFrames; lag++)
      if (score[lag] > score[best]) best = lag;
    double lagF = best;
    if (best > minLag && best < maxLag) {
      double a = score[best - 1], b = score[best], c = score[best + 1];
      double d = a - 2 * b + c;
      if (std::abs(d) > 1e-12) lagF = best + 0.5 * (a - c) / d;
    }
    if (score[best] > 0) bpm = 60.0 * fps / lagF;
  }

  // ---- Beat tracking (Ellis 2007 dynamic programming).
  std::vector<double> beats;
  if (bpm > 0 && nFrames > 8) {
    const double period = 60.0 * fps / bpm;
    const double tightness = 100.0;
    std::vector<double> cum(nFrames);
    std::vector<int> back(nFrames, -1);
    int lo = (int)std::lround(period / 2), hi = (int)std::lround(period * 2);
    for (int t = 0; t < nFrames; t++) {
      double best = -1e300;
      int bi = -1;
      for (int prev = t - hi; prev <= t - lo; prev++) {
        if (prev < 0) continue;
        double r = std::log((double)(t - prev) / period);
        double s = cum[prev] - tightness * r * r;
        if (s > best) { best = s; bi = prev; }
      }
      cum[t] = onset[t] + (bi >= 0 ? std::max(0.0, best) : 0.0);
      back[t] = bi;
    }
    int start = std::max(0, nFrames - (int)std::lround(period));
    int last = start;
    for (int t = start; t < nFrames; t++)
      if (cum[t] > cum[last]) last = t;
    std::vector<int> idx;
    for (int t = last; t >= 0; t = back[t]) idx.push_back(t);
    std::reverse(idx.begin(), idx.end());
    // Trim weak beats at the edges (silence / fades).
    auto smooth = movingAverage(onset, 2);
    double ms = 0;
    for (double v : smooth) ms += v * v;
    double thresh = 0.5 * std::sqrt(ms / std::max(1, nFrames));
    size_t a = 0, b = idx.size();
    while (a < b && smooth[idx[a]] < thresh) a++;
    while (b > a && smooth[idx[b - 1]] < thresh) b--;
    for (size_t i = a; i < b; i++) beats.push_back(idx[i] / fps);
  }

  // ---- Downbeats: choose the 4/4 phase with the strongest low-end hits.
  std::vector<double> downbeats;
  int downPhase = 0;
  if (beats.size() >= 8) {
    double ph[4] = {0, 0, 0, 0};
    for (size_t i = 0; i < beats.size(); i++) {
      int f = (int)std::lround(beats[i] * fps);
      double s = 0;
      for (int d = -2; d <= 2; d++) {
        int k = f + d;
        if (k >= 0 && k < nFrames) s += lowFlux[k] + 0.25 * low[k];
      }
      ph[i % 4] += s;
    }
    downPhase = (int)(std::max_element(ph, ph + 4) - ph);
    for (size_t i = downPhase; i < beats.size(); i += 4) downbeats.push_back(beats[i]);
  }

  // ---- Song-level normalization references.
  const double rmsRef = std::max(1e-6, percentile(rms, 0.95));
  const double lowRef = percentile(low, 0.98), midRef = percentile(mid, 0.98), highRef = percentile(high, 0.98);
  const double onsetRef = percentile(onset, 0.98);
  std::vector<double> rmsNorm(nFrames);
  for (int t = 0; t < nFrames; t++) rmsNorm[t] = std::min(1.0, rms[t] / rmsRef);

  // ---- Sections: novelty on a self-similarity matrix of beat-synchronous features.
  const bool beatUnits = beats.size() >= 32;
  std::vector<double> unitTimes;
  if (beatUnits) {
    unitTimes = beats;
  } else {
    for (double t = 0; t < duration; t += 1.0) unitTimes.push_back(t);
  }
  const int U = (int)unitTimes.size();
  std::vector<double> boundaries;  // in seconds, excluding 0 and duration
  if (U >= 8) {
    const int D = 16;
    std::vector<std::array<double, D>> feat(U);
    for (int u = 0; u < U; u++) {
      int a = std::clamp((int)(unitTimes[u] * fps), 0, nFrames - 1);
      int b = u + 1 < U ? std::clamp((int)(unitTimes[u + 1] * fps), a + 1, nFrames) : nFrames;
      std::array<double, 12> c{};
      double el = 0, em = 0, eh = 0, er = 0;
      for (int t = a; t < b; t++) {
        for (int k = 0; k < 12; k++) c[k] += chroma[t][k];
        el += low[t]; em += mid[t]; eh += high[t]; er += rms[t];
      }
      double n = std::max(1, b - a), norm = 0;
      for (double v : c) norm += v * v;
      norm = std::sqrt(norm) + 1e-9;
      for (int k = 0; k < 12; k++) feat[u][k] = c[k] / norm;
      feat[u][12] = std::log1p(el / n);
      feat[u][13] = std::log1p(em / n);
      feat[u][14] = std::log1p(eh / n);
      feat[u][15] = std::log1p(1000.0 * er / n);
    }
    // z-score the energy dims, weight them against the (unit-norm) chroma.
    for (int d = 12; d < D; d++) {
      double m = 0, v = 0;
      for (auto& f : feat) m += f[d];
      m /= U;
      for (auto& f : feat) v += (f[d] - m) * (f[d] - m);
      double sd = std::sqrt(v / U) + 1e-9;
      for (auto& f : feat) f[d] = 0.45 * (f[d] - m) / sd;
    }
    // Light temporal smoothing.
    auto sm = feat;
    for (int u = 0; u < U; u++)
      for (int d = 0; d < D; d++) {
        double s = 0;
        int n = 0;
        for (int k = std::max(0, u - 1); k <= std::min(U - 1, u + 1); k++) { s += feat[k][d]; n++; }
        sm[u][d] = s / n;
      }
    std::vector<double> nrm(U);
    for (int u = 0; u < U; u++) {
      double s = 0;
      for (double v : sm[u]) s += v * v;
      nrm[u] = std::sqrt(s) + 1e-9;
    }
    auto sim = [&](int i, int j) {
      double s = 0;
      for (int d = 0; d < D; d++) s += sm[i][d] * sm[j][d];
      return s / (nrm[i] * nrm[j]);
    };
    const int h = beatUnits ? 16 : 8;
    const double sigma = h / 2.0;
    std::vector<double> novelty(U, 0.0);
    for (int i = 0; i < U; i++) {
      double s = 0;
      for (int a = -h; a < h; a++) {
        int ia = i + a;
        if (ia < 0 || ia >= U) continue;
        for (int b = -h; b < h; b++) {
          int ib = i + b;
          if (ib < 0 || ib >= U) continue;
          double sign = ((a < 0) == (b < 0)) ? 1.0 : -1.0;
          double g = std::exp(-((a + 0.5) * (a + 0.5) + (b + 0.5) * (b + 0.5)) / (2 * sigma * sigma));
          s += sign * g * sim(ia, ib);
        }
      }
      novelty[i] = std::max(0.0, s);
    }
    double nMax = *std::max_element(novelty.begin(), novelty.end());
    std::vector<int> candidates;
    const int localR = beatUnits ? 4 : 3;
    for (int i = h / 2; i < U - h / 2; i++) {
      bool isMax = true;
      for (int k = std::max(0, i - localR); k <= std::min(U - 1, i + localR); k++)
        if (novelty[k] > novelty[i]) { isMax = false; break; }
      if (isMax && novelty[i] >= 0.15 * nMax) candidates.push_back(i);
    }
    std::sort(candidates.begin(), candidates.end(), [&](int a, int b) { return novelty[a] > novelty[b]; });
    const int maxSections = std::clamp((int)(duration / 15.0), 2, 14);
    const int minUnits = beatUnits ? 16 : 8;
    const double minSeconds = 8.0;
    std::vector<int> chosen;
    for (int c : candidates) {
      if ((int)chosen.size() >= maxSections - 1) break;
      if (unitTimes[c] < minSeconds || duration - unitTimes[c] < minSeconds) continue;
      bool ok = true;
      for (int q : chosen)
        if (std::abs(q - c) < minUnits || std::abs(unitTimes[q] - unitTimes[c]) < minSeconds) { ok = false; break; }
      if (ok) chosen.push_back(c);
    }
    std::sort(chosen.begin(), chosen.end());
    for (int c : chosen) {
      double t = unitTimes[c];
      // Snap to the nearest downbeat within one bar.
      if (!downbeats.empty()) {
        auto it = std::min_element(downbeats.begin(), downbeats.end(),
                                   [&](double a, double b) { return std::abs(a - t) < std::abs(b - t); });
        if (std::abs(*it - t) <= 4 * 60.0 / std::max(bpm, 1.0)) t = *it;
      }
      if (boundaries.empty() || t - boundaries.back() > 4.0) boundaries.push_back(t);
    }
  } else if (duration > 40) {
    for (double t = 20; t < duration - 10; t += 20) boundaries.push_back(t);
  }

  // ---- Section descriptors.
  std::vector<double> edges = {0.0};
  edges.insert(edges.end(), boundaries.begin(), boundaries.end());
  edges.push_back(duration);
  const double cRef = std::max(1.0, percentile(centroid, 0.95));
  struct Sec { double start, end, energy, bright, trend; };
  std::vector<Sec> secs;
  for (size_t i = 0; i + 1 < edges.size(); i++) {
    int a = std::clamp((int)(edges[i] * fps), 0, nFrames - 1);
    int b = std::clamp((int)(edges[i + 1] * fps), a + 1, nFrames);
    double e = mean(rmsNorm, a, b);
    double br = std::min(1.0, mean(centroid, a, b) / cRef);
    int m = (a + b) / 2;
    double trend = mean(rmsNorm, m, b) - mean(rmsNorm, a, m);
    secs.push_back({edges[i], edges[i + 1], e, br, trend});
  }
  double eMax = 1e-9;
  for (auto& s : secs) eMax = std::max(eMax, s.energy);
  json sections = json::array();
  for (size_t i = 0; i < secs.size(); i++) {
    const auto& s = secs[i];
    double rel = s.energy / eMax;
    bool nextIsPeak = i + 1 < secs.size() && secs[i + 1].energy / eMax >= 0.85;
    std::string name;
    if (i == 0 && rel < 0.7 && secs.size() > 1) name = "intro";
    else if (i + 1 == secs.size() && rel < 0.7 && secs.size() > 1) name = "outro";
    else if (rel >= 0.85) name = "peak";
    else if (nextIsPeak && s.trend > 0.02) name = "build";
    else if (rel < 0.5) name = "breakdown";
    else name = "verse";
    double bars = bpm > 0 ? (s.end - s.start) * bpm / 240.0 : 0;
    std::string trend = s.trend > 0.05 ? "rising" : (s.trend < -0.05 ? "falling" : "steady");
    sections.push_back({{"id", (int)i},
                        {"name", name},
                        {"start", r3(s.start)},
                        {"end", r3(s.end)},
                        {"energy", r3(rel)},
                        {"loudness", r3(s.energy)},
                        {"brightness", r3(s.bright)},
                        {"trend", trend},
                        {"bars", std::round(bars * 10) / 10}});
  }

  // ---- Key (Krumhansl-Schmuckler).
  std::string key = "C", mode = "major";
  {
    const double major[12] = {6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88};
    const double minor[12] = {6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17};
    std::array<double, 12> total{};
    for (auto& c : chroma)
      for (int k = 0; k < 12; k++) total[k] += c[k];
    auto corr = [&](const double* prof, int root) {
      double mx = 0, my = 0;
      for (int k = 0; k < 12; k++) { mx += total[(k + root) % 12]; my += prof[k]; }
      mx /= 12; my /= 12;
      double num = 0, dx = 0, dy = 0;
      for (int k = 0; k < 12; k++) {
        double a = total[(k + root) % 12] - mx, b = prof[k] - my;
        num += a * b; dx += a * a; dy += b * b;
      }
      return num / (std::sqrt(dx * dy) + 1e-12);
    };
    double best = -2;
    for (int r = 0; r < 12; r++) {
      double cMaj = corr(major, r), cMin = corr(minor, r);
      if (cMaj > best) { best = cMaj; key = kKeyNames[r]; mode = "major"; }
      if (cMin > best) { best = cMin; key = kKeyNames[r]; mode = "minor"; }
    }
  }

  // ---- Global descriptors.
  std::vector<double> rmsDb(nFrames);
  for (int t = 0; t < nFrames; t++) rmsDb[t] = 20 * std::log10(rms[t] + 1e-9);
  double loudDb = 20 * std::log10(mean(rms, 0, rms.size()) + 1e-9);
  double dynRange = percentile(rmsDb, 0.95) - percentile(rmsDb, 0.10);
  double brightness = std::min(1.0, mean(centroid, 0, centroid.size()) / 4000.0);
  int onsetCount = 0;
  for (int t = 1; t + 1 < nFrames; t++)
    if (onset[t] > 1.5 && onset[t] >= onset[t - 1] && onset[t] > onset[t + 1]) onsetCount++;
  double onsetRate = onsetCount / std::max(1.0, duration);
  double meanEnergy = mean(rmsNorm, 0, rmsNorm.size());
  double arousal = std::clamp(0.35 * std::clamp((bpm - 70) / 100.0, 0.0, 1.0) + 0.35 * meanEnergy +
                                  0.30 * std::clamp(onsetRate / 6.0, 0.0, 1.0), 0.0, 1.0);
  double valence = std::clamp(0.5 + (mode == "major" ? 0.18 : -0.18) + 0.3 * (brightness - 0.4), 0.0, 1.0);

  // ---- Waveform peaks for the timeline.
  json peaks = json::array();
  {
    const int P = 1200;
    double gmax = 1e-9;
    std::vector<double> pk(P, 0.0);
    for (int p = 0; p < P; p++) {
      size_t a = x.size() * p / P, b = x.size() * (p + 1) / P;
      float m = 0;
      for (size_t i = a; i < b; i++) m = std::max(m, std::abs(x[i]));
      pk[p] = m;
      gmax = std::max(gmax, (double)m);
    }
    for (double v : pk) peaks.push_back(r3(v / gmax));
  }

  json beatsJ = json::array(), downJ = json::array();
  for (double b : beats) beatsJ.push_back(r3(b));
  for (double b : downbeats) downJ.push_back(r3(b));

  return {
      {"version", 1},
      {"duration", r3(duration)},
      {"sampleRate", sr},
      {"bpm", std::round(bpm * 10) / 10},
      {"key", key},
      {"mode", mode},
      {"loudnessDb", std::round(loudDb * 10) / 10},
      {"dynamicRangeDb", std::round(dynRange * 10) / 10},
      {"brightness", r3(brightness)},
      {"onsetRate", r3(onsetRate)},
      {"arousal", r3(arousal)},
      {"valence", r3(valence)},
      {"beats", beatsJ},
      {"downbeats", downJ},
      {"sections", sections},
      {"frames",
       {{"fps", r3(fps)},
        {"low", toBytes(low, lowRef, 0.8)},
        {"mid", toBytes(mid, midRef, 0.8)},
        {"high", toBytes(high, highRef, 0.8)},
        {"rms", toBytes(rmsNorm, 1.0, 1.0)},
        {"onset", toBytes(onset, onsetRef, 1.0)}}},
      {"peaks", peaks},
  };
}

json summarize(const json& a) {
  json s = json::object();
  for (const char* k : {"duration", "bpm", "key", "mode", "loudnessDb", "dynamicRangeDb", "brightness",
                        "onsetRate", "arousal", "valence", "sections"})
    if (a.contains(k)) s[k] = a[k];
  s["beatCount"] = a.value("beats", json::array()).size();
  return s;
}

}  // namespace analysis
