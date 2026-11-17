/**
 * Kontrak sumber data DormChain.
 *
 * UI hanya bergantung pada interface ini, bukan pada SimulationService secara
 * langsung. Adapter sungguhan (MQTT over TLS / REST backend / Web3) cukup
 * mengimplementasikan method yang sama lalu didaftarkan di `dataSource.js`.
 *
 * @typedef {'locked' | 'unlocked'} LockState
 * @typedef {'resident' | 'admin'} Role
 * @typedef {'in' | 'out'} Direction
 * @typedef {'nfc' | 'remote' | 'sensor'} AccessMethod
 * @typedef {'realtime' | 'offline'} SyncMode
 *
 * @typedef {Object} DoorNode
 * @property {string} roomId
 * @property {number} floor
 * @property {boolean} hardwareOnline   Node ESP32 terhubung ke mesh/gateway.
 * @property {number} battery           Persentase baterai UPS (0-100).
 * @property {number} voltage           Tegangan baterai (V).
 * @property {number} rssi              Kekuatan sinyal (dBm).
 * @property {LockState} lockState
 * @property {'inside' | 'outside'} presence
 * @property {{ at: number, by: string, method: AccessMethod } | null} lastAccess
 *
 * @typedef {Object} Credential
 * @property {string} id
 * @property {string} name
 * @property {string} phone
 * @property {string} roomId
 * @property {Role} role
 * @property {string} uid               UID kartu asli (hanya untuk simulasi).
 * @property {string} uidHash           SHA-256 dari UID, yang disimpan on-chain.
 * @property {string} validUntil        YYYY-MM-DD
 * @property {'active' | 'revoked'} status
 * @property {number} registeredAt
 * @property {string} txHash
 *
 * @typedef {Object} AuditEntry
 * @property {string} id
 * @property {number} eventAt           Waktu tap terjadi di node.
 * @property {number} syncedAt          Waktu tercatat di ledger.
 * @property {string} roomId
 * @property {string} name
 * @property {Direction} direction
 * @property {AccessMethod} method
 * @property {SyncMode} syncMode        'offline' = susulan dari antrean store-and-forward.
 * @property {string} txHash
 * @property {number} blockNumber
 *
 * @typedef {Object} QueuedEvent
 * @property {string} id
 * @property {number} eventAt
 * @property {string} roomId
 * @property {string} name
 * @property {Direction} direction
 * @property {AccessMethod} method
 * @property {'internet' | 'node'} reason
 *
 * @typedef {Object} DormChainState
 * @property {boolean} internetOnline
 * @property {boolean} autoTraffic
 * @property {{ network: string, blockNumber: number, contractAddress: string, pingMs: number, lastFlush: { count: number, at: number } | null }} ledger
 * @property {string[]} roomIds
 * @property {Record<string, DoorNode>} nodes
 * @property {Credential[]} credentials
 * @property {AuditEntry[]} auditLog     Terbaru di depan (urut eventAt).
 * @property {QueuedEvent[]} localQueue  Antrean lokal ESP32 saat luring.
 *
 * @typedef {Object} DataSource
 * @property {(listener: () => void) => () => void} subscribe
 * @property {() => DormChainState} getState   Snapshot immutable.
 * @property {() => void} start
 * @property {() => void} stop
 * @property {(roomId: string) => Promise<{ txHash: string }>} unlockDoor
 * @property {(roomId: string) => Promise<{ flushed: number }>} pingNode
 * @property {(roomId: string, role: Role, excludeId?: string) => { used: number, limit: number }} getQuota
 * @property {(options: { timeoutMs: number, signal?: AbortSignal }) => Promise<{ uid: string }>} waitForCardTap
 * @property {(payload: Omit<Credential, 'id'|'uidHash'|'status'|'registeredAt'|'txHash'|'uid'>, uid: string) => Promise<Credential>} registerCredential
 * @property {(credentialId: string) => Promise<{ txHash: string }>} revokeCredential
 *
 * Kontrol khusus simulasi (tidak wajib ada di adapter produksi; UI memeriksa
 * `capabilities.simulation` sebelum menampilkannya):
 * @property {{ simulation: boolean }} capabilities
 * @property {(online: boolean) => { flushed: number }} [setInternet]
 * @property {(enabled: boolean) => void} [setAutoTraffic]
 * @property {(roomId: string) => { queued: boolean }} [simulateTap]
 * @property {() => boolean} [simulateCardTap]
 * @property {() => void} [reset]
 */

export class ServiceError extends Error {
  /**
   * @param {'OFFLINE' | 'NODE_OFFLINE' | 'QUOTA_EXCEEDED' | 'DUPLICATE_UID' | 'TIMEOUT' | 'ABORTED' | 'NOT_FOUND' | 'INVALID' | 'BUSY'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}
