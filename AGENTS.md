# Project management

Resolve routine implementation choices independently. Ask only when missing information or authorization prevents any useful progress.

Keep changes focused on the user's goal. Finish authorized work, handle failures, and report what changed, how it was verified, and any remaining blockers. Never claim a check passed unless it ran successfully.

NEVER diagnose an issue as pre-existing, especially when it comes to lints/formatting.

# Commits throughout the work

Make commits throughout implementation at meaningful, coherent milestones, rather than saving everything for a final commit. Commit completed fixes, refactors, and features separately when they form useful reviewable steps. Validate each milestone with checks appropriate to its scope before committing. Keep commits understandable and write messages that explain the change and its purpose.

Inspect the diff before staging. Stage only files and hunks belonging to your work. Preserve existing user changes and never commit secrets, generated clutter, or unrelated files. Do not rewrite existing commits or push to a remote unless the user authorizes it. If a commit is blocked, report the reason and continue any independent work.

A commit is required at the end of your turn.

Use conventional commits format.

Never push code.

# Refactoring authority

You are authorized to refactor code whenever your edits would otherwise make it overly long, repetitive, hard to read, or difficult to maintain. Treat cleanup needed for a clear implementation as part of the task. Simplify control flow, split functions or modules at useful boundaries, remove duplication, and use names that explain intent.

Verify behavior with relevant checks, and make a separate refactor commit to improve reviewability.

# Legacy handling

Do not implement any data migration. SlopeMP has no public release, no created songs, and no users. No legacy branches, no maintaining old features, no hidden state.

Changes should be thorough throughout the code. No legacy code, unreachable code, legacy code, or unclear code names are allowed as a result of a rename change.

Do not migrate preferences.
