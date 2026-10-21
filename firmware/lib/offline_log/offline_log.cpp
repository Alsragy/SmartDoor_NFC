// ============================================================================
// offline_log.cpp — implementasi serialisasi & idempotensi Offline_Log_Queue.
// Paritas dengan src/services/offlineLog.js. Lihat offline_log.h.
// _Requirements: 5.1, 6.3, 6.4_
// ============================================================================
#include "offline_log.h"

#include <unordered_set>

#include <ArduinoJson.h>

namespace smartdoor {
namespace offline_log {

std::string identityKey(const LogEvent& event) { return event.id; }

// --------------------------------------------------------------------------
// Serialisasi JSONL
// --------------------------------------------------------------------------

bool serialize(const LogEvent& event, std::string& out) {
  JsonDocument doc;
  // Hanya sertakan field yang bermakna; field kosong tetap ditulis untuk
  // field inti (paritas dengan JSON.stringify yang menyertakan properti yang
  // ada pada objek). `ts_unverified` hanya ditulis bila diset (Req 5.5).
  doc["id"] = event.id;
  doc["ts"] = event.ts;
  doc["uid"] = event.uid;
  doc["result"] = event.result;
  doc["sync_type"] = event.sync_type;
  if (event.has_ts_unverified) {
    doc["ts_unverified"] = event.ts_unverified;
  }

  std::string line;
  serializeJson(doc, line);

  // Pertahanan ekstra: baris JSONL tidak boleh memuat newline (serializeJson
  // meng-escape '\n' di dalam string menjadi "\\n", jadi ini tak tercapai
  // secara teori — paritas dengan guard di offlineLog.js).
  if (line.find('\n') != std::string::npos ||
      line.find('\r') != std::string::npos) {
    out.clear();
    return false;
  }
  out = std::move(line);
  return true;
}

std::string serialize(const LogEvent& event) {
  std::string out;
  if (!serialize(event, out)) {
    return std::string();
  }
  return out;
}

bool parse(const std::string& line, LogEvent& out) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, line);
  if (err) {
    return false;
  }
  JsonObjectConst root = doc.as<JsonObjectConst>();
  if (root.isNull()) {
    return false;  // baris JSONL harus berupa objek JSON
  }

  out = LogEvent{};
  if (!root["id"].isNull()) {
    out.id = root["id"].as<const char*>() ? root["id"].as<const char*>() : "";
  }
  if (!root["ts"].isNull()) {
    out.ts = root["ts"].as<const char*>() ? root["ts"].as<const char*>() : "";
  }
  if (!root["uid"].isNull()) {
    out.uid = root["uid"].as<const char*>() ? root["uid"].as<const char*>() : "";
  }
  if (!root["result"].isNull()) {
    out.result =
        root["result"].as<const char*>() ? root["result"].as<const char*>() : "";
  }
  if (!root["sync_type"].isNull()) {
    out.sync_type = root["sync_type"].as<const char*>()
                        ? root["sync_type"].as<const char*>()
                        : "";
  }
  if (!root["ts_unverified"].isNull()) {
    out.has_ts_unverified = true;
    out.ts_unverified = root["ts_unverified"].as<int>();
  }
  return true;
}

// --------------------------------------------------------------------------
// Pruning ber-ACK & deduplikasi
// --------------------------------------------------------------------------

std::vector<LogEvent> pruneAcked(const std::vector<LogEvent>& queue,
                                 const std::vector<std::string>& ackedIds) {
  if (ackedIds.empty()) {
    return queue;  // salinan; tidak memutasi input
  }
  std::unordered_set<std::string> acked(ackedIds.begin(), ackedIds.end());

  std::vector<LogEvent> out;
  out.reserve(queue.size());
  for (const auto& event : queue) {
    const std::string key = identityKey(event);
    // Entri tanpa identitas tidak mungkin ber-ACK -> pertahankan.
    if (key.empty()) {
      out.push_back(event);
      continue;
    }
    if (acked.find(key) == acked.end()) {
      out.push_back(event);
    }
  }
  return out;
}

std::vector<LogEvent> dedupeByKey(const std::vector<LogEvent>& logs) {
  std::unordered_set<std::string> seen;
  std::vector<LogEvent> out;
  out.reserve(logs.size());
  for (const auto& event : logs) {
    const std::string key = identityKey(event);
    if (key.empty()) {
      // Tanpa identitas: tak dapat dibandingkan sebagai duplikat -> simpan.
      out.push_back(event);
      continue;
    }
    if (seen.find(key) != seen.end()) {
      continue;
    }
    seen.insert(key);
    out.push_back(event);
  }
  return out;
}

// --------------------------------------------------------------------------
// Counter idempotency
// --------------------------------------------------------------------------

namespace {

std::string zeroPad(uint64_t value, int width) {
  std::string digits = std::to_string(value);
  if (width > 0 && static_cast<int>(digits.size()) < width) {
    digits.insert(digits.begin(), width - static_cast<int>(digits.size()), '0');
  }
  return digits;
}

}  // namespace

std::string formatId(const std::string& deviceId, uint64_t counter, int width) {
  return deviceId + "-" + zeroPad(counter, width);
}

std::string next(IdempotencyCounter& counter) {
  // Naikkan dulu agar id tidak pernah memakai counter 0.
  counter.counter += 1;
  return formatId(counter.deviceId, counter.counter, counter.width);
}

NextId peekNext(const std::string& deviceId, uint64_t currentCounter,
                int width) {
  NextId result;
  result.nextCounter = currentCounter + 1;
  result.id = formatId(deviceId, result.nextCounter, width);
  return result;
}

}  // namespace offline_log
}  // namespace smartdoor
