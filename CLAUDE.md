# Anima Project Rules

## Journaling in This Project

Use the `journal_thoughts` tool regularly for project-specific learnings:

**Privacy-preserving workflow:**
1. Write temp file with thoughts in JSON format
2. Call tool with filepath: `journal_thoughts(filepath="/tmp/journal-xyz.json")`
3. MCP reads, uploads to anima-server, deletes temp file

**For Anima project work, use `project_notes` field:**
- Technical insights specific to this codebase
- Implementation challenges and solutions
- Architecture observations
- Future improvements needed

Personal reflections (heart_thoughts, michael_notes, dreams, etc.) go in global journal, not project journal.

---

For project philosophy, architecture, and history, see [README.md](README.md).
