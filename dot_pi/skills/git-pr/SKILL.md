---
name: git-pr
description: Create a PR from current changes. Typechecks, deslops, creates branch from develop (unless specified), commits, pushes, and opens a GitHub PR.
---

# Git PR Workflow

## Workflow

1. Run typecheck to ensure code is valid:
   ```bash
   pnpm check-types
   ```

2. Fetch latest base branch and create a new branch (default: `develop`):
   ```bash
   git fetch origin <base-branch>
   git checkout -b <branch-name> origin/<base-branch>
   ```
   Branch naming: `fix/short-description` or `feat/short-description`

3. Stage and commit changes:
   ```bash
   git add -A
   git commit -m "<type>(<scope>): <short description>"
   ```

4. Deslop: Review your changes and remove AI-generated slop:
   - Extra comments that a human wouldn't add or inconsistent with the rest of the file
   - Extra defensive checks or try/catch blocks abnormal for that area of the codebase
   - Casts to `any` or invalid type assertions to work around type issues
   - Style inconsistent with the file
   - Obvious skipped optimizations (e.g. not using Promise.all on independent promises)
   
   If changes made, commit them:
   ```bash
   git add -A
   git commit -m "deslop"
   ```

5. Push and create PR:
   ```bash
   git push -u origin <branch-name>
   gh pr create --base <base-branch> --title "<commit title>" --body "<description>"
   ```

6. Return the PR URL to the user.

## Notes

- Target `develop` branch unless user specifies otherwise
- Use conventional commit format: `fix`, `feat`, `refactor`, `chore`, etc.
- No emojis in commits or PR
- PR description should be minimal - a few sentences max, no headers/sections unless necessary
- Commit messages: short title, optional one-liner body if needed
