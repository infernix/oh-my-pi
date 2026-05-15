import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getSSHConfigPath, TempDir } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../src/capability";
import { type SSHHost, sshCapability } from "../src/capability/ssh";
import { Settings } from "../src/config/settings";
import { loadCapability } from "../src/discovery";
import { createAgentSession } from "../src/sdk";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { addSSHHost, removeSSHHost } from "../src/ssh/config-writer";
import { loadSshTool, type ToolSession } from "../src/tools";

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

describe("AgentSession SSH tool refresh", () => {
	const tempDirs: TempDir[] = [];
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		for (const tempDir of tempDirs.splice(0)) {
			tempDir.removeSync();
		}
		resetCapabilities();
	});

	function createSession(cwd: string, initialTools: AgentTool[] = [], registryTools = initialTools): AgentSession {
		const settings = Settings.isolated({ "compaction.enabled": false });
		const sessionManager = SessionManager.inMemory(cwd);
		const toolSession: ToolSession = {
			cwd,
			hasUI: false,
			settings,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
		};
		const toolRegistry = new Map(registryTools.map(tool => [tool.name, tool]));
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: initialTools,
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: {} as never,
			toolRegistry,
			reloadSshTool: async () => (await loadSshTool(toolSession)) as unknown as AgentTool | null,
			rebuildSystemPrompt: async (toolNames, tools) => ({
				systemPrompt: toolNames.map(name => `${name}:${tools.get(name)?.description ?? ""}`),
			}),
		});
		sessions.push(session);
		return session;
	}

	it("adds the ssh tool after a first host is written over a cached missing config", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();

		const preWrite = await loadCapability<SSHHost>(sshCapability.id, { cwd });
		expect(preWrite.items).toHaveLength(0);

		const session = createSession(cwd);
		await addSSHHost(getSSHConfigPath("project", cwd), "staging", { host: "192.0.2.10" });
		await session.refreshSshTool({ activateIfAvailable: true });

		expect(session.getAllToolNames()).toContain("ssh");
		expect(session.getActiveToolNames()).toContain("ssh");
		expect(session.getToolByName("ssh")?.description).toContain("staging (192.0.2.10)");
		expect(session.agent.state.systemPrompt.join("\n")).toContain("staging (192.0.2.10)");
	});

	it("removes ssh from registry and active tools when the last host is removed", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const configPath = getSSHConfigPath("project", cwd);

		await addSSHHost(configPath, "prod", { host: "203.0.113.9" });
		const sshTool = await loadSshTool({
			cwd,
			hasUI: false,
			settings: Settings.isolated({ "compaction.enabled": false }),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
		});
		expect(sshTool).not.toBeNull();

		const session = createSession(cwd, [sshTool as unknown as AgentTool]);
		await removeSSHHost(configPath, "prod");
		await session.refreshSshTool();

		expect(session.getAllToolNames()).not.toContain("ssh");
		expect(session.getActiveToolNames()).not.toContain("ssh");
	});

	it("does not activate an existing inactive ssh tool during reload refresh", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const configPath = getSSHConfigPath("project", cwd);

		await addSSHHost(configPath, "dev", { host: "192.0.2.20" });
		const sshTool = await loadSshTool({
			cwd,
			hasUI: false,
			settings: Settings.isolated({ "compaction.enabled": false }),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
		});
		expect(sshTool).not.toBeNull();

		await addSSHHost(configPath, "dev2", { host: "192.0.2.21" });
		const session = createSession(cwd, [], [sshTool as unknown as AgentTool]);
		await session.refreshSshTool({ activateIfAvailable: true });

		expect(session.getAllToolNames()).toContain("ssh");
		expect(session.getActiveToolNames()).not.toContain("ssh");
		expect(session.getToolByName("ssh")?.description).toContain("dev2 (192.0.2.21)");
	});

	it("reloads ssh from the session's current cwd after move", async () => {
		const oldProject = TempDir.createSync("@pi-ssh-refresh-old-");
		const newProject = TempDir.createSync("@pi-ssh-refresh-new-");
		const agentDir = TempDir.createSync("@pi-ssh-refresh-agent-");
		tempDirs.push(oldProject, newProject, agentDir);
		const sessionManager = SessionManager.inMemory(oldProject.path());
		const { session } = await createAgentSession({
			cwd: oldProject.path(),
			agentDir: agentDir.path(),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: createModel(),
			enableLsp: false,
			enableMCP: false,
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: ["ssh"],
			skipPythonPreflight: true,
		});
		sessions.push(session);

		await sessionManager.moveTo(newProject.path());
		await addSSHHost(getSSHConfigPath("project", newProject.path()), "moved", { host: "198.51.100.8" });
		await session.refreshSshTool({ activateIfAvailable: true });

		expect(session.getActiveToolNames()).toContain("ssh");
		expect(session.getToolByName("ssh")?.description).toContain("moved (198.51.100.8)");
	});
});
