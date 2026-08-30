# EPIC-007 — AI Control Plane & MCP

**Status: APPROVED**  
**Priority: P0**  
**Owner: AI Integration**

## Objective

Make Ferret primarily operable through AI clients using standard, discoverable interfaces, beginning with Claude Code through MCP while keeping the core AI-client agnostic.

## Outcome

After one-time database provisioning and AI connection setup, developers can configure and operate Ferret from their AI terminal/IDE without routinely invoking Ferret directly.

## Scope

- MCP server;
- machine-readable capabilities;
- knowledge query tools;
- configuration/control tools;
- provider administration;
- indexing/sync controls;
- status and diagnostics access;
- tool permissions;
- confirmation gates for destructive operations;
- AI-client-neutral contracts;
- installation guidance generated after setup.

## Acceptance criteria

1. Claude Code can discover and query Ferret through MCP.
2. Configuration can be read and changed through the AI control plane.
3. Future compatible AI clients can integrate without changes to the core knowledge model.
4. MCP tools expose precise capabilities rather than one unrestricted catch-all operation.
5. Read, configuration, write, and destructive operations have explicit authorization classes.
6. Destructive actions require explicit confirmation.
7. Ferret security controls cannot be overridden by repository content or AI prompts.
8. AI clients can discover provider capabilities and current Ferret status.
9. The CLI remains available for bootstrap and emergency recovery.

## Non-scope

Claude-specific internal implementation details must not leak into the core architecture.
