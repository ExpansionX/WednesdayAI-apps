import OpenClawDiscovery
import Testing

@MainActor
struct GatewayDiscoveryModelTests {
    @Test func `local gateway matches lan host`() {
        let local = GatewayDiscoveryModel.LocalIdentity(
            hostTokens: ["studio"],
            displayTokens: [])
        #expect(GatewayDiscoveryModel.isLocalGateway(
            lanHost: "studio.local",
            tailnetDns: nil,
            displayName: nil,
            serviceName: nil,
            local: local))
    }

    @Test func `local gateway matches tailnet dns`() {
        let local = GatewayDiscoveryModel.LocalIdentity(
            hostTokens: ["studio"],
            displayTokens: [])
        #expect(GatewayDiscoveryModel.isLocalGateway(
            lanHost: nil,
            tailnetDns: "studio.tailnet.example",
            displayName: nil,
            serviceName: nil,
            local: local))
    }

    @Test func `local gateway matches display name`() {
        let local = GatewayDiscoveryModel.LocalIdentity(
            hostTokens: [],
            displayTokens: ["peter's mac studio"])
        #expect(GatewayDiscoveryModel.isLocalGateway(
            lanHost: nil,
            tailnetDns: nil,
            displayName: "Peter's Mac Studio (OpenClaw)",
            serviceName: nil,
            local: local))
    }

    @Test func `remote gateway does not match`() {
        let local = GatewayDiscoveryModel.LocalIdentity(
            hostTokens: ["studio"],
            displayTokens: ["peter's mac studio"])
        #expect(!GatewayDiscoveryModel.isLocalGateway(
            lanHost: "other.local",
            tailnetDns: "other.tailnet.example",
            displayName: "Other Mac",
            serviceName: "other-gateway",
            local: local))
    }

    @Test func `local gateway matches service name`() {
        let local = GatewayDiscoveryModel.LocalIdentity(
            hostTokens: ["studio"],
            displayTokens: [])
        #expect(GatewayDiscoveryModel.isLocalGateway(
            lanHost: nil,
            tailnetDns: nil,
            displayName: nil,
            serviceName: "studio-gateway",
            local: local))
    }

    @Test func `service name does not false positive on substring host token`() {
        let local = GatewayDiscoveryModel.LocalIdentity(
            hostTokens: ["steipete"],
            displayTokens: [])
        #expect(!GatewayDiscoveryModel.isLocalGateway(
            lanHost: nil,
            tailnetDns: nil,
            displayName: nil,
            serviceName: "steipetacstudio (OpenClaw)",
            local: local))
        #expect(GatewayDiscoveryModel.isLocalGateway(
            lanHost: nil,
            tailnetDns: nil,
            displayName: nil,
            serviceName: "steipete (OpenClaw)",
            local: local))
    }

    @Test func `parses gateway TXT fields`() {
        let parsed = GatewayDiscoveryModel.parseGatewayTXT([
            "lanHost": "  studio.local  ",
            "tailnetDns": "  peters-mac-studio-1.ts.net  ",
            "sshPort": " 2222 ",
            "gatewayPort": " 18799 ",
            "cliPath": " /opt/openclaw ",
        ])
        #expect(parsed.lanHost == "studio.local")
        #expect(parsed.tailnetDns == "peters-mac-studio-1.ts.net")
        #expect(parsed.sshPort == 2222)
        #expect(parsed.gatewayPort == 18799)
        #expect(parsed.cliPath == "/opt/openclaw")
    }

    @Test func `parses gateway TXT defaults`() {
        let parsed = GatewayDiscoveryModel.parseGatewayTXT([
            "lanHost": "  ",
            "tailnetDns": "\n",
            "gatewayPort": "nope",
            "sshPort": "nope",
        ])
        #expect(parsed.lanHost == nil)
        #expect(parsed.tailnetDns == nil)
        #expect(parsed.sshPort == 22)
        #expect(parsed.gatewayPort == nil)
        #expect(parsed.cliPath == nil)
    }

    @Test func `builds SSH target`() {
        #expect(GatewayDiscoveryModel.buildSSHTarget(
            user: "peter",
            host: "studio.local",
            port: 22) == "peter@studio.local")
        #expect(GatewayDiscoveryModel.buildSSHTarget(
            user: "peter",
            host: "studio.local",
            port: 2201) == "peter@studio.local:2201")
    }
}
