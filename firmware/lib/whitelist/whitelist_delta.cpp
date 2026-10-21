// ============================================================================
// whitelist_delta.cpp — implementasi Versioning & Hash Kartu / Delta Sync.
// Paritas dengan src/services/whitelistVersion.js. Lihat whitelist_delta.h.
// _Requirements: 4.3_
// ============================================================================
#include "whitelist_delta.h"

#include <algorithm>
#include <unordered_map>
#include <unordered_set>

#include <ArduinoJson.h>

namespace smartdoor {
namespace whitelist {

namespace {

// Pemisah antar-field pada serialisasi kanonik (ASCII Unit Separator, 0x1F),
// paritas dengan FIELD_SEPARATOR ('\u001f') di whitelistVersion.js — mustahil
// muncul di dalam uid sehingga tidak ambigu.
constexpr char kFieldSeparator = '\x1f';

// Kartu "aktif" = BUKAN removed. Gunakan isRemoved() sebagai sumber kebenaran.

}  // namespace

std::string canonicalizeCard(const Card& card) {
  // Urutan tetap: uid, key_version, status, expired_at. String kosong sudah
  // mewakili nilai "tidak diset" (paritas canonicalField(null) -> "").
  std::string out;
  out.reserve(card.uid.size() + card.key_version.size() + card.status.size() +
              card.expired_at.size() + 3);
  out.append(card.uid);
  out.push_back(kFieldSeparator);
  out.append(card.key_version);
  out.push_back(kFieldSeparator);
  out.append(card.status);
  out.push_back(kFieldSeparator);
  out.append(card.expired_at);
  return out;
}

std::string cardHash(const Card& card, const Sha256Fn& hashFn) {
  return std::string(hashPrefix()) + hashFn(canonicalizeCard(card));
}

std::string dbHash(const std::vector<Card>& cards, const Sha256Fn& hashFn) {
  // Hitung card_hash tiap kartu, lalu urutkan berdasar uid (determinisme tak
  // bergantung urutan input) — paritas dengan dbHash() di JS.
  struct Entry {
    std::string uid;
    std::string hash;
  };
  std::vector<Entry> entries;
  entries.reserve(cards.size());
  for (const auto& card : cards) {
    entries.push_back(Entry{card.uid, cardHash(card, hashFn)});
  }
  std::sort(entries.begin(), entries.end(),
            [](const Entry& a, const Entry& b) { return a.uid < b.uid; });

  std::string joined;
  for (size_t i = 0; i < entries.size(); ++i) {
    if (i != 0) {
      joined.push_back(kFieldSeparator);
    }
    joined.append(entries[i].hash);
  }
  return std::string(hashPrefix()) + hashFn(joined);
}

bool isRemoved(const Card& card) {
  // REVOKED dihapus total (Req 10.2); UNPROVISIONED tidak layak di whitelist
  // aktif. Keduanya diperlakukan "removed" (paritas isRemoved() di JS).
  return card.status == status::kRevoked() ||
         card.status == status::kUnprovisioned();
}

std::vector<Card> activeCards(const std::vector<Card>& cards) {
  std::vector<Card> out;
  out.reserve(cards.size());
  for (const auto& card : cards) {
    if (!isRemoved(card)) {
      out.push_back(card);
    }
  }
  return out;
}

Snapshot applyDelta(const Snapshot& localSnapshot, const Delta& delta,
                    const Sha256Fn& hashFn) {
  // Mulai dari salinan kartu lokal (tidak memutasi input).
  std::vector<Card> cards = localSnapshot.cards;

  // Index uid -> posisi untuk upsert, menjaga urutan sisip (paritas Map di JS).
  std::unordered_map<std::string, size_t> indexByUid;
  indexByUid.reserve(cards.size() * 2 + 1);
  for (size_t i = 0; i < cards.size(); ++i) {
    indexByUid[cards[i].uid] = i;
  }

  // 1) Upsert kartu changed (abaikan yang ternyata removed demi konsistensi).
  for (const auto& card : delta.changed) {
    if (isRemoved(card)) {
      continue;
    }
    auto it = indexByUid.find(card.uid);
    if (it != indexByUid.end()) {
      cards[it->second] = card;
    } else {
      indexByUid[card.uid] = cards.size();
      cards.push_back(card);
    }
  }

  // 2) Hapus uid yang dicabut (Req 10.2, Property 6).
  std::vector<Card> nextCards;
  if (delta.removed.empty()) {
    nextCards = std::move(cards);
  } else {
    std::unordered_set<std::string> removedSet(delta.removed.begin(),
                                               delta.removed.end());
    nextCards.reserve(cards.size());
    for (auto& card : cards) {
      if (removedSet.find(card.uid) == removedSet.end()) {
        nextCards.push_back(std::move(card));
      }
    }
  }

  // 3) Hitung ulang hash & versi atas kartu AKTIF.
  Snapshot result;
  result.db_version = delta.db_version;
  result.cards = std::move(nextCards);
  result.db_hash = dbHash(activeCards(result.cards), hashFn);
  return result;
}

bool verifyDbHash(const Snapshot& snapshot, const std::string& expectedDbHash) {
  return snapshot.db_hash == expectedDbHash;
}

bool applyDeltaVerified(const Snapshot& localSnapshot, const Delta& delta,
                        Snapshot& out, const Sha256Fn& hashFn) {
  out = applyDelta(localSnapshot, delta, hashFn);
  // Bila server tidak menyertakan db_hash, anggap tak dapat diverifikasi (false).
  if (delta.db_hash.empty()) {
    return false;
  }
  return verifyDbHash(out, delta.db_hash);
}

// --------------------------------------------------------------------------
// (De)serialisasi JSON
// --------------------------------------------------------------------------

namespace {

// Ambil sebuah field sebagai string, toleran terhadap angka/null.
std::string asString(JsonVariantConst v) {
  if (v.isNull()) {
    return std::string();
  }
  if (v.is<const char*>()) {
    const char* s = v.as<const char*>();
    return s ? std::string(s) : std::string();
  }
  if (v.is<long long>()) {
    return std::to_string(v.as<long long>());
  }
  if (v.is<double>()) {
    // Hindari notasi ilmiah/desimal tak terduga: hanya dipakai bila bukan int.
    return std::to_string(v.as<double>());
  }
  return std::string();
}

int64_t asInt64(JsonVariantConst v) {
  if (v.isNull()) {
    return 0;
  }
  if (v.is<long long>()) {
    return v.as<long long>();
  }
  if (v.is<double>()) {
    return static_cast<int64_t>(v.as<double>());
  }
  return 0;
}

Card parseCard(JsonObjectConst obj) {
  Card card;
  card.uid = asString(obj["uid"]);
  card.key_version = asString(obj["key_version"]);
  card.status = asString(obj["status"]);
  card.expired_at = asString(obj["expired_at"]);
  card.db_version = asInt64(obj["db_version"]);
  return card;
}

}  // namespace

bool parseDeltaJson(const std::string& json, Delta& out) {
  JsonDocument doc;  // ArduinoJson v7: dokumen elastis (Req 18.3 di firmware
                     // sebaiknya memakai batas; host memakai heap biasa).
  DeserializationError err = deserializeJson(doc, json);
  if (err) {
    return false;
  }
  JsonObjectConst root = doc.as<JsonObjectConst>();
  if (root.isNull()) {
    return false;
  }

  out = Delta{};
  JsonArrayConst changed = root["changed"].as<JsonArrayConst>();
  if (!changed.isNull()) {
    for (JsonObjectConst c : changed) {
      out.changed.push_back(parseCard(c));
    }
  }
  JsonArrayConst removed = root["removed"].as<JsonArrayConst>();
  if (!removed.isNull()) {
    for (JsonVariantConst r : removed) {
      out.removed.push_back(asString(r));
    }
  }
  out.db_version = asInt64(root["db_version"]);
  out.db_hash = asString(root["db_hash"]);
  return true;
}

bool parseSnapshotJson(const std::string& json, Snapshot& out) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, json);
  if (err) {
    return false;
  }
  JsonObjectConst root = doc.as<JsonObjectConst>();
  if (root.isNull()) {
    return false;
  }

  out = Snapshot{};
  out.db_version = asInt64(root["db_version"]);
  out.db_hash = asString(root["db_hash"]);
  JsonArrayConst cards = root["cards"].as<JsonArrayConst>();
  if (!cards.isNull()) {
    for (JsonObjectConst c : cards) {
      out.cards.push_back(parseCard(c));
    }
  }
  return true;
}

std::string serializeSnapshotJson(const Snapshot& snapshot) {
  JsonDocument doc;
  doc["db_version"] = snapshot.db_version;
  doc["db_hash"] = snapshot.db_hash;
  JsonArray cards = doc["cards"].to<JsonArray>();
  for (const auto& card : snapshot.cards) {
    JsonObject obj = cards.add<JsonObject>();
    obj["uid"] = card.uid;
    obj["key_version"] = card.key_version;
    obj["status"] = card.status;
    obj["expired_at"] = card.expired_at;
    obj["db_version"] = card.db_version;
  }
  std::string out;
  serializeJson(doc, out);
  return out;
}

}  // namespace whitelist
}  // namespace smartdoor
