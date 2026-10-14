import Darwin
import Testing
@testable import OpenClawDiscovery

struct WideAreaGatewayDiscoveryTests {
    @Test func `discovers beacon from tailnet dns sd fallback`() {
        let statusJson = """
        {
          "Self": { "TailscaleIPs": ["100.69.232.64"] },
          "Peer": {
            "peer-1": { "TailscaleIPs": ["100.123.224.76"] }
          }
        }
        """

        let context = WideAreaGatewayDiscovery.DiscoveryContext(
            tailscaleStatus: { statusJson },
            dig: { args, _ in
                let recordType = args.last ?? ""
                let nameserver = args.first(where: { $0.hasPrefix("@") }) ?? ""
                if recordType == "PTR" {
                    if nameserver == "@100.123.224.76" {
                        return "steipetacstudio-gateway._openclaw-gw._tcp.openclaw.internal.\n"
                    }
                    return ""
                }
                if recordType == "SRV" {
                    return "0 0 18789 steipetacstudio.openclaw.internal."
                }
                if recordType == "TXT" {
                    return "\"displayName=Peter\\226\\128\\153s Mac Studio (OpenClaw)\" \"gatewayPort=18789\" \"tailnetDns=peters-mac-studio-1.sheep-coho.ts.net\" \"cliPath=/Users/steipete/openclaw/src/entry.ts\""
                }
                return ""
            },
            // Injected instead of a process-env setenv: tests must not mutate
            // global state, and Foundation may snapshot the environment, so a
            // mid-run setenv is not reliably visible under parallel runs.
            wideAreaDomain: { "openclaw.internal" },
            // A user-initiated probe queue: the utility-QoS live queue can be
            // starved past the discovery deadline when parallel tests (the
            // glob differential vectors) saturate the runner.
            probeQueue: .global(qos: .userInitiated))

        let beacons = WideAreaGatewayDiscovery.discover(
            timeoutSeconds: 2.0,
            context: context)

        // Index only after the count expectation holds: indexing an empty
        // array after a failed expectation aborts the whole test run.
        guard beacons.count == 1 else {
            Issue.record("expected exactly 1 beacon, got \(beacons.count)")
            return
        }
        let beacon = beacons[0]
        let expectedDisplay = "Peter\u{2019}s Mac Studio (OpenClaw)"
        #expect(beacon.displayName == expectedDisplay)
        #expect(beacon.port == 18789)
        #expect(beacon.gatewayPort == 18789)
        #expect(beacon.tailnetDns == "peters-mac-studio-1.sheep-coho.ts.net")
        #expect(beacon.cliPath == "/Users/steipete/openclaw/src/entry.ts")
    }
}
