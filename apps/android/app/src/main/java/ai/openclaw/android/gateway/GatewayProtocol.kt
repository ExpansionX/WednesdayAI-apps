package ai.openclaw.android.gateway

// Role-aware client bounds (plan protocol-v4 §6 P2): sockets advertise [3, 4], independent of
// the synced schema version and of server admission floors, so a gateway-only rollback to v3
// never strands installed clients. Hand-written (Android has no codegen): bump manually with
// the generator counterparts in WednesdayAI-apps (Swift) and apps/mentra-glass (TypeScript).
const val GATEWAY_PROTOCOL_VERSION = 4
const val GATEWAY_MIN_PROTOCOL_VERSION = 3
const val GATEWAY_MIN_NODE_PROTOCOL_VERSION = 3
