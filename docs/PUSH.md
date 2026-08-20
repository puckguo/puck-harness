# Pushing to GitHub — what to do

The first commit is done locally (`058cafa`). This file explains how to push to GitHub.

## Prerequisites

You need a GitHub Personal Access Token (PAT) with `repo` scope.

If you don't have one:
1. Go to https://github.com/settings/tokens
2. "Generate new token" → "Fine-grained tokens" (or classic)
3. Scopes: `repo` (full)
4. Copy the token (you'll only see it once)

## Steps

### 1. Make sure the GitHub repo exists

Go to https://github.com/new and create:
- Owner: `puckguo`
- Name: `puck-harness`
- Visibility: **Private** first (you can flip to Public after verifying)
- DO NOT initialize with README, .gitignore, or license (we have them all)

### 2. Add the remote + push

```bash
cd /c/guo/SoftwareDevelopment/research/puck-agent/puck
git remote add origin https://github.com/puckguo/puck-harness.git
git branch -M main
git push -u origin main
```

When prompted:
- Username: `puckguo`
- Password: **paste your PAT** (not your GitHub password)

### 3. Verify on GitHub

Visit https://github.com/puckguo/puck-harness

You should see:
- README.md rendered on the front page
- 11 packages under `packages/`
- LICENSE, CONTRIBUTING.md, SECURITY.md at root
- 167 files in the first commit
- **No `auth.json`, no `.puck/`, no `brainstorm.md`** (gitignored)

### 4. (Optional) Make the repo Public

Once you've verified the contents:
1. Repo → Settings → Danger Zone → "Change repository visibility" → Public
2. Confirm

## After public release

The first npm publish is also still pending. After GitHub push:

```bash
# In each package dir, in dependency order:
cd packages/core && npm publish --access public && cd ../..
cd packages/llm && npm publish --access public && cd ../..
cd packages/session && npm publish --access public && cd ../..
cd packages/tools && npm publish --access public && cd ../..
cd packages/features && npm publish --access public && cd ../..
cd packages/timing && npm publish --access public && cd ../..
cd packages/store && npm publish --access public && cd ../..
cd packages/memory && npm publish --access public && cd ../..
cd packages/sdk && npm publish --access public && cd ../..
cd packages/web && npm publish --access public && cd ../..
cd packages/cli && npm publish --access public && cd ../..
```

**Order matters**:底层包先发。The CLI depends on everything else.

Verify each step:
```bash
npm view @puck-agent/core version   # should show 0.1.0
npm view puck version
```

## If something went wrong

- **Wrong files committed?** `git reset --soft HEAD~1` to uncommit (keeps changes), then `git restore --staged <file>` to unstage
- **Sensitive key leaked?** Rotate the key immediately at the provider. The git history is permanent, so even after deletion the key is compromised.
- **Need to undo first commit?** `git update-ref -d HEAD` (resets branch, keeps all files)
