/**
 * A2A piri fanout agent discovery — user-scope only.
 *
 * Fork of the piri example extension's agents.ts
 * (jinwon-int/piri v0.83.0-piri.1,
 * packages/coding-agent/examples/extensions/subagent/agents.ts), hardened per
 * docs/specs/piri-lane-fanout-reuse/phase-2-wiring.md WS2 (#1836):
 *
 * Scope pinning (Phase-1 gap 5) happens here, at the discovery layer — the
 * project-scope lookup (`.piri/agents/` walking up from cwd) is deleted, not
 * just discouraged, so repo-controlled agent prompts can never load on this
 * lane regardless of what a prompt asks for. Only the host-controlled roster
 * under the piri config dir (`<piri-config>/agent/agents/`) is discovered.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export function discoverAgents() {
	const dir = path.join(getAgentDir(), "agents");
	const agents = [];

	if (!fs.existsSync(dir)) return agents;

	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t) => String(t).trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source: "user",
			filePath,
		});
	}

	return agents;
}
